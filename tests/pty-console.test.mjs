import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  assert.equal(result.uninstallRestored, true);
  assert.equal(result.ownedChildrenAfterExit, 0);
});
