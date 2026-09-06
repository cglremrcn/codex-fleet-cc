import fs from "node:fs/promises";
import path from "node:path";
import { resolveOwnedPath, workspaceKey } from "./paths.mjs";
import { readPrivateRecord, writePrivateRecord, assertRecordDirectory } from "./private-record.mjs";
import { redactText } from "./redaction.mjs";

const KEY = /^[a-f0-9]{32}$/u;
const MAX_PROJECTS = 256;
const MAX_BYTES = 8192;

function recordPath(dataDir, key) {
  if (!KEY.test(key)) throw new TypeError("Invalid project key.");
  return resolveOwnedPath(dataDir, "workspaces", key, "project.json");
}

function validateRecord(record, key) {
  if (!record || record.schemaVersion !== 1 || record.workspaceKey !== key
    || !path.isAbsolute(record.workspacePath ?? "") || record.workspacePath.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(record.workspacePath)
    || typeof record.name !== "string" || record.name.length < 1 || record.name.length > 120
    || /[\u0000-\u001f\u007f\u0080-\u009f]/u.test(record.name)) {
    throw new Error("Malformed project registration.");
  }
  return record;
}

/** Registration is local, stores a canonical path privately, and never starts a model. */
export async function registerWorkspace(dataDir, workspacePath, options = {}) {
  await assertRecordDirectory(resolveOwnedPath(dataDir, "workspaces"), { create: true });
  const canonical = await fs.realpath(path.resolve(workspacePath));
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Workspace must be a directory.");
  const key = await workspaceKey(canonical);
  const old = await readPrivateRecord(recordPath(dataDir, key), { missing: null, maxBytes: MAX_BYTES });
  const record = validateRecord({
    schemaVersion: 1, workspaceKey: key, workspacePath: canonical,
    name: options.name ?? old?.name ?? (path.basename(canonical) || "Workspace")
  }, key);
  if (JSON.stringify(old) !== JSON.stringify(record)) await writePrivateRecord(recordPath(dataDir, key), record, { maxBytes: MAX_BYTES });
  return { workspaceKey: key, name: record.name, registered: true };
}

/** Control routing rechecks the private registration; row-supplied paths are never trusted. */
export async function resolveRegisteredWorkspace(dataDir, key) {
  await assertRecordDirectory(resolveOwnedPath(dataDir, "workspaces"));
  const record = validateRecord(await readPrivateRecord(recordPath(dataDir, key), { maxBytes: MAX_BYTES }), key);
  const canonical = await fs.realpath(record.workspacePath);
  if (!(await fs.stat(canonical)).isDirectory() || await workspaceKey(canonical) !== key) {
    throw new Error("Project location changed; register its actual workspace again.");
  }
  return { ...record, workspacePath: canonical };
}

export async function listRegisteredWorkspaces(dataDir) {
  const root = resolveOwnedPath(dataDir, "workspaces");
  let directory;
  try { await assertRecordDirectory(root); directory = await fs.opendir(root); }
  catch (error) { if (error.code === "ENOENT") return { projects: [], warnings: [], truncated: false }; throw error; }
  const keys = [];
  let truncated = false;
  for await (const entry of directory) {
    if (!KEY.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (keys.length >= MAX_PROJECTS) { truncated = true; break; }
    keys.push(entry.name);
  }
  keys.sort();
  const projects = [], warnings = [];
  for (const key of keys) {
    try {
      const raw = await readPrivateRecord(recordPath(dataDir, key), { missing: null, maxBytes: MAX_BYTES });
      if (!raw) {
        projects.push({ workspaceKey: key, name: `Unregistered ${key.slice(0, 8)}`, registered: false });
      } else {
        const record = validateRecord(raw, key);
        projects.push({ workspaceKey: key, name: redactText(record.name), registered: true });
      }
    } catch {
      warnings.push({ workspaceKey: key, reason: "project-registration-unreadable" });
    }
  }
  return { projects, warnings, truncated };
}
