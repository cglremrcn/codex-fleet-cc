#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { runCli } from "./lib/cli.mjs";

const MAX_INPUT_BYTES = 64 * 1024;

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
    const active = payload.lanes.filter((lane) =>
      ["queued", "starting", "running", "cancelling", "outcome_unknown"].includes(lane.status)
    ).length;
    const context = active > 0
      ? `Fleet has ${active} active or unresolved lane(s) for this workspace. Use /fleet:status before scheduling overlapping work.`
      : null;
    process.stdout.write(`${JSON.stringify(hookResponse(context))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(hookResponse())}\n`);
  }
}

await main();
