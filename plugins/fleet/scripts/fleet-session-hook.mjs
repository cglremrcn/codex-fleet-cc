#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCli } from "./lib/cli.mjs";
import { getFleetDataDir, resolveOwnedPath } from "./lib/paths.mjs";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OWNERSHIP_BYTES = 64 * 1024;
const ACTIVE_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "cancelling",
  "outcome_unknown"
]);

function ownershipCandidates() {
  const candidates = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    candidates.push(path.resolve(process.env.CLAUDE_PLUGIN_DATA, "ownership.json"));
  }
  const fallbackRoot = resolveOwnedPath(
    getFleetDataDir(process.env, process.platform, os.homedir()),
    "integration"
  );
  candidates.push(path.resolve(fallbackRoot, "ownership.json"));
  return [...new Set(candidates)];
}

async function inspectOwnership(candidate) {
  try {
    const metadata = await fs.lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_OWNERSHIP_BYTES) {
      return { state: "invalid", version: null };
    }
    const payload = JSON.parse(await fs.readFile(candidate, "utf8"));
    return payload?.schemaVersion === 1
      && payload?.status === "applied"
      && typeof payload.version === "string"
      ? { state: "applied", version: payload.version }
      : { state: "invalid", version: null };
  } catch (error) {
    return {
      state: error?.code === "ENOENT" ? "missing" : "invalid",
      version: null
    };
  }
}

async function installedPluginVersion() {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")
  );
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Fleet plugin version is unavailable.");
  }
  return manifest.version;
}

async function setupContext() {
  const installedVersion = await installedPluginVersion();
  const inspections = await Promise.all(ownershipCandidates().map(inspectOwnership));
  const applied = inspections.find((inspection) => inspection.state === "applied");
  if (applied?.version === installedVersion) return null;
  if (applied) {
    return `Fleet Ctrl+G integration runtime ${applied.version} does not match installed plugin `
      + `${installedVersion}. Invoke Fleet setup to preview an ownership-verified upgrade; do not `
      + "edit Claude settings or the launcher manually.";
  }
  if (inspections.some((inspection) => inspection.state === "invalid")) {
    return "Fleet integration ownership is unreadable or incomplete. Use /fleet:doctor before setup; do not overwrite settings or ownership state.";
  }
  return "Fleet is installed but Ctrl+G Fleet Console is not configured. Ask the user exactly one plain confirmation question: \"Enable Ctrl+G Fleet Console now?\" Wait for an explicit yes. If the user explicitly agrees, invoke the Fleet setup skill, keep its preview token internal, and apply only the exact preview. Never ask the user to copy or paste a token. This SessionStart hook is read-only and must not modify settings.";
}

async function readHookInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_INPUT_BYTES) {
      throw new Error("Hook input exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hookResponse(additionalContext = null) {
  const response = { continue: true, suppressOutput: true };
  if (additionalContext) {
    response.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext
    };
  }
  return response;
}

async function main() {
  try {
    const input = await readHookInput();
    const candidate = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const workspace = path.resolve(candidate);
    let output = "";
    const exitCode = await runCli(["status", "--json", "--workspace", workspace], {
      cwd: workspace,
      stdout: (value) => { output += value; },
      stderr: () => undefined
    });
    if (exitCode !== 0 && exitCode !== 5) {
      process.stdout.write(`${JSON.stringify(hookResponse())}\n`);
      return;
    }
    const payload = JSON.parse(output);
    const active = payload.lanes.filter((lane) => ACTIVE_STATUSES.has(lane.status)).length;
    const messages = [];
    if (active > 0) {
      messages.push(
        `Fleet has ${active} active or unresolved lane(s) for this workspace. Use /fleet:status before scheduling overlapping work.`
      );
    }
    const onboarding = await setupContext();
    if (onboarding) messages.push(onboarding);
    const context = messages.length > 0 ? messages.join("\n\n") : null;
    process.stdout.write(`${JSON.stringify(hookResponse(context))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(hookResponse())}\n`);
  }
}

await main();
