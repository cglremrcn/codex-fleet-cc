import crypto from "node:crypto";
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ControlError, digest } from "./control-contract.mjs";

const exec = promisify(execFile);
const DEFAULTS = Object.freeze({ maxFiles: 4096, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, timeoutMs: 15000 });
const changed = () => new ControlError("SOURCE_CHANGED_DURING_READ", "The workspace changed while evidence was being read. Observe and capture a new checkpoint.");

export function safeRelativeFile(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || value.startsWith("/") || value.split("/").some((part) => !part || [".", "..", ".git"].includes(part.toLowerCase()))) {
    throw new ControlError("SOURCE_PATH_UNSAFE", "Evidence paths must be safe workspace-relative files, not metadata, devices or parent paths.");
  }
  return value;
}

function signature(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}`; }

async function checkedPath(root, relative) {
  safeRelativeFile(relative);
  if (await fs.realpath(root) !== root) throw changed();
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const entry = await fs.lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ControlError("SOURCE_PATH_UNSAFE", "Source/evidence ancestors must be real directories within the workspace.");
  }
  return path.join(root, ...relative.split("/"));
}

/** Hash bounded bytes, not a model's assertion or a filename. No file content is returned. */
export async function hashWorkspaceFile(root, relative, { maxBytes = DEFAULTS.maxFileBytes, allowMissing = false, deadline = Infinity } = {}) {
  let file;
  try { file = await checkedPath(root, relative); }
  catch (error) {
    if (error.code === "ENOENT" && allowMissing) return { path: relative, missing: true, bytes: 0, signature: null };
    throw error;
  }
  let before;
  try { before = await fs.lstat(file, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT" && allowMissing) return { path: relative, missing: true, bytes: 0, signature: null };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new ControlError("SOURCE_PATH_UNSAFE", "Only regular non-symlink, non-hardlinked files can supply source evidence.");
  if (before.size > BigInt(maxBytes)) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Source/evidence file exceeds the bounded hashing budget.");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (signature(await handle.stat({ bigint: true })) !== signature(before)) throw changed();
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(Math.min(128 * 1024, maxBytes + 1));
    let total = 0;
    for (;;) {
      if (Date.now() > deadline) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Source capture exceeded its wall-clock budget.");
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Source/evidence file grew beyond its hashing budget.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (signature(before) !== signature(after) || BigInt(total) !== before.size) throw changed();
    await checkedPath(root, relative);
    if (signature(await fs.lstat(file, { bigint: true })) !== signature(before)) throw changed();
    return { path: relative, sha256: hash.digest("hex"), bytes: total, executable: Number(before.mode & 0o111n), signature: signature(before) };
  } finally { await handle.close(); }
}

function gitEnvironment() {
  const env = { ...process.env };
  // The selected repository, not inherited Git overrides, owns the observation.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" };
}

export async function captureSource(workspacePath, options = {}) {
  const limits = { ...DEFAULTS, ...options };
  if (Object.keys(DEFAULTS).some((key) => !Number.isSafeInteger(limits[key]) || limits[key] < 1)) throw new TypeError("Invalid source capture budget.");
  const root = await fs.realpath(workspacePath), deadline = Date.now() + limits.timeoutMs;
  const git = async (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Source capture exceeded its wall-clock budget.");
    try {
      const result = await exec("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
        cwd: root, env: gitEnvironment(), shell: false, windowsHide: true,
        timeout: Math.min(5000, remaining), maxBuffer: 2 * 1024 * 1024, encoding: "buffer"
      });
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch {
      throw new ControlError("SOURCE_GIT_UNAVAILABLE", "Source evidence requires a readable Git repository with a commit and bounded valid UTF-8 metadata.");
    }
  };
  const top = (await git(["rev-parse", "--show-toplevel"])).trim();
  if (await fs.realpath(top) !== root) throw new ControlError("SOURCE_ROOT_MISMATCH", "Select the Git worktree root, not a subdirectory, for revision-bound verification.");
  async function inventory() {
    const head = (await git(["rev-parse", "--verify", "HEAD"])).trim();
    const staged = await git(["ls-files", "--stage", "-z"]);
    const others = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const tracked = staged.split("\0").filter(Boolean).map((entry) => {
      const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/u.exec(entry);
      if (!match) throw new ControlError("SOURCE_INDEX_UNSUPPORTED", "Unmerged entries, symlinks and submodules require separate isolation/evidence; they are not silently verified.");
      return { mode: match[1], oid: match[2], path: safeRelativeFile(match[3]) };
    });
    const files = [...new Set([...tracked.map((item) => item.path), ...others.split("\0").filter(Boolean).map(safeRelativeFile)])].sort();
    if (files.length > limits.maxFiles) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Source file count exceeds the capture budget.");
    return { head, indexDigest: digest(tracked, "fleet-index-v1"), files, tracked: new Set(tracked.map((item) => item.path)) };
  }
  const before = await inventory(), records = [];
  let bytes = 0;
  for (const name of before.files) {
    const entry = await hashWorkspaceFile(root, name, { maxBytes: limits.maxFileBytes, allowMissing: before.tracked.has(name), deadline });
    bytes += entry.bytes;
    if (bytes > limits.maxTotalBytes) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Total source bytes exceed the capture budget.");
    records.push(entry);
  }
  const after = await inventory();
  if (before.head !== after.head || before.indexDigest !== after.indexDigest || JSON.stringify(before.files) !== JSON.stringify(after.files)) throw changed();
  for (const entry of records) {
    if (Date.now() > deadline) throw new ControlError("SOURCE_BUDGET_EXCEEDED", "Source capture exceeded its wall-clock budget.");
    const metadata = await fs.lstat(path.join(root, ...entry.path.split("/")), { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if ((metadata ? signature(metadata) : null) !== entry.signature) throw changed();
  }
  const content = records.map(({ signature: _signature, ...record }) => record);
  return Object.freeze({ schemaVersion: 1, scope: "git-index+working-tree+nonignored-untracked", head: before.head,
    indexDigest: before.indexDigest, digest: digest({ head: before.head, index: before.indexDigest, content }, "fleet-source-v1"),
    files: records.length, bytes, ignoredFilesBound: false });
}
