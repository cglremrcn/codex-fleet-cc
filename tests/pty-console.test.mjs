import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runConsole } from "../plugins/fleet/scripts/lib/console-controller.mjs";

const SMOKE_SCRIPT = fileURLToPath(
  new URL("../scripts/run-pty-smoke.mjs", import.meta.url)
);
const MAX_OUTPUT_BYTES = 64 * 1024;

function runSmokeCli(timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      SMOKE_SCRIPT,
      "--assert-clean-terminal",
      "--assert-draft-unchanged"
    ], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PTY smoke CLI did not release its native worker."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("real PTY CLI exits after returning to the Claude host", async () => {
  const run = await runSmokeCli();

  assert.equal(run.code, 0, run.stderr || `PTY smoke ended with ${run.signal}.`);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.editorOpened, true);
  assert.equal(result.returnedToHost, true);
  assert.equal(result.draftUnchanged, true);
  assert.equal(result.terminalRestored, true);
  assert.equal(result.installedLauncherChecked, true);
  assert.equal(result.installedLauncherHandoff, true);
  assert.equal(result.sessionOpened, true);
  assert.equal(result.sameThreadMessageSent, true);
  assert.equal(result.returnedFromSession, true);
  assert.equal(result.uninstallRestored, true);
  assert.equal(result.ownedChildrenAfterExit, 0);
});

test("delayed snapshot reads do not trap local input or terminal restoration", async () => {
  const { EventEmitter } = await import("node:events");
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const writes = [];
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => { stdin.isRaw = value; };
  stdin.resume = () => undefined;
  stdin.pause = () => undefined;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 24;
  stdout.write = (value) => { writes.push(String(value)); return true; };
  let tick = null;
  const clock = {
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() { tick = null; },
    setTimeout,
    clearTimeout
  };
  let reads = 0;
  let restored = false;
  const running = runConsole({
    io: { stdin, stdout, lifecycle: new EventEmitter() },
    clock,
    refreshTimeoutMs: 20,
    readSnapshot: async () => {
      reads += 1;
      if (reads === 1) {
        return {
          schemaVersion: 1,
          workspace: { name: "last-good", branch: "main" },
          runtime: { health: "ready", protocol: "compatible" },
          lanes: [{
            id: "last-good-lane",
            role: "investigator",
            label: "Retained lane",
            model: "gpt-5.6-sol",
            effort: "medium",
            status: "running",
            phase: "running"
          }]
        };
      }
      return new Promise(() => undefined);
    },
    terminalSession: async (_io, run) => {
      stdin.setRawMode(true);
      try {
        return await run({ signal: new AbortController().signal });
      } finally {
        stdin.setRawMode(false);
        restored = true;
      }
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  tick();
  await new Promise((resolve) => setTimeout(resolve, 35));
  stdin.emit("data", Buffer.from("\u001b[Fq"));
  await running;

  assert.equal(restored, true);
  assert.equal(stdin.isRaw, false);
  assert.match(writes.join("\n"), /OBSERVATION STALE/iu);
  assert.match(writes.join("\n"), /last-good-lane/iu);
});
