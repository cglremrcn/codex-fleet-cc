import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import * as pty from "node-pty";
import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";
import {
  applySetup,
  previewSetup,
  previewUninstallSetup,
  uninstallSetup
} from "../plugins/fleet/scripts/lib/setup.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOST = path.join(ROOT, "tests", "fixtures", "fake-claude-editor-host.mjs");
const SESSION_HOST = path.join(ROOT, "tests", "fixtures", "fake-fleet-console-host.mjs");
const RUNTIME_SOURCE = path.join(ROOT, "plugins", "fleet", "scripts");

function parseArguments(argv) {
  const allowed = new Set(["--assert-clean-terminal", "--assert-draft-unchanged"]);
  for (const argument of argv) {
    if (!allowed.has(argument)) throw new Error(`Unknown PTY smoke flag: ${argument}`);
  }
  return {
    assertCleanTerminal: argv.includes("--assert-clean-terminal"),
    assertDraftUnchanged: argv.includes("--assert-draft-unchanged")
  };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function verifyInstalledLauncher(launcherPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [
      launcherPath,
      "--benchmark-startup",
      "--plain"
    ], {
      cwd: ROOT,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Installed launcher benchmark timed out."));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-16 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16 * 1024);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Installed launcher benchmark failed: ${stderr.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result.schemaVersion === 1 && result.backgroundProcesses === 0);
      } catch (error) {
        reject(new Error(
          `Installed launcher returned invalid benchmark JSON: ${error.message}. `
          + `Launcher stderr: ${stderr.trim()}`
        ));
      }
    });
  });
}

async function verifyEmbeddedSession(root, options = {}) {
  const recordPath = path.join(root, "session-message.json");
  let output = "";
  let enterSent = false;
  let messageSent = false;
  let returnSent = false;
  let quitSent = false;
  const terminal = pty.spawn(process.execPath, [SESSION_HOST, recordPath], {
    name: "xterm-256color",
    cols: options.columns ?? 140,
    rows: options.rows ?? 34,
    cwd: ROOT,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      NO_COLOR: "1"
    },
    useConpty: process.platform === "win32",
    useConptyDll: process.platform === "win32"
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error(`Embedded session PTY smoke timed out.\n${output.slice(-8192)}`));
    }, options.timeoutMs ?? 20_000);
    const dataSubscription = terminal.onData((chunk) => {
      output = `${output}${chunk}`.slice(-256 * 1024);
      if (!enterSent && /FLEET\/\/OPS/u.test(output)) {
        enterSent = true;
        terminal.write("\r");
      }
      if (enterSent && !messageSent && /FLEET\/\/CODEX SESSION/u.test(output)) {
        messageSent = true;
        terminal.write("continue inside authority\r");
      }
      if (messageSent && !returnSent && /MESSAGE SENT/u.test(output)) {
        returnSent = true;
        terminal.write("\u0007");
      }
      if (returnSent && !quitSent && /RETURNED TO FLEET DASHBOARD/u.test(output)) {
        quitSent = true;
        terminal.write("q");
      }
    });
    const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      dataSubscription.dispose();
      queueMicrotask(() => exitSubscription.dispose());
      if (exitCode === 0) resolve();
      else reject(new Error(`Embedded session PTY exited with ${signal ?? exitCode}.`));
    });
  });

  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  return {
    sessionOpened: output.includes("FLEET//CODEX SESSION"),
    sameThreadMessageSent: record.laneId === "pty-session-lane"
      && record.threadId === record.originalThreadId
      && record.message === "continue inside authority",
    returnedFromSession: output.includes("RETURNED TO FLEET DASHBOARD")
  };
}

export async function runPtySmoke(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fleet-pty-"));
  const draftPath = path.join(root, "claude-draft.txt");
  fs.writeFileSync(draftPath, "draft must remain byte-for-byte unchanged\n", "utf8");
  const draftBefore = fs.readFileSync(draftPath);
  const claudeConfigDir = path.join(root, ".claude");
  const settingsPath = path.join(claudeConfigDir, "settings.json");
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const originalEditor = `"${process.execPath}" "${HOST}" --editor`;
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ env: { EDITOR: originalEditor } }, null, 2)}\n`,
    "utf8"
  );
  const setupPlan = await previewSetup({
    settingsPath,
    pluginDataDir: path.join(root, "fleet-data"),
    runtimeSourceDir: RUNTIME_SOURCE,
    nodeExecutable: process.execPath,
    platform: process.platform,
    version: "0.1.0"
  });
  await applySetup({
    ...setupPlan,
    confirmation: setupPlan.confirmationToken
  });
  const installedLauncherChecked = process.platform === "win32"
    ? true
    : await verifyInstalledLauncher(setupPlan.launcherPath);
  let output = "";
  let editorSent = false;
  let quitSent = false;
  const diagnosticTail = () => output
    .slice(-8 * 1024)
    .replaceAll(root, "<temp>")
    .replaceAll(os.homedir(), "<home>");

  try {
    const executable = process.execPath;
    const arguments_ = [HOST, draftPath, setupPlan.launcherPath, "--installed-launcher"];
    const terminal = pty.spawn(executable, arguments_, {
      name: "xterm-256color",
      cols: options.columns ?? 140,
      rows: options.rows ?? 34,
      cwd: ROOT,
      env: { ...process.env, TERM: "xterm-256color" },
      useConpty: process.platform === "win32",
      useConptyDll: process.platform === "win32"
    });
    const ownedPid = terminal.pid;
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        terminal.kill();
        reject(new Error("PTY smoke timed out."));
      }, options.timeoutMs ?? 15_000);
      const dataSubscription = terminal.onData((chunk) => {
        output = `${output}${chunk}`.slice(-256 * 1024);
        if (!editorSent && /FLEET\/\/OPS|FLEET\/\/COMPACT|FLEET\/\/NARROW/u.test(output)) {
          editorSent = true;
          terminal.write("e");
        }
        if (editorSent && !quitSent && output.includes("FAKE_EDITOR:OPEN")) {
          quitSent = true;
          terminal.write("q");
        }
      });
      const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
        clearTimeout(timer);
        dataSubscription.dispose();
        try {
          terminal.kill();
        } catch {
          // A naturally exited ConPTY can already have released its process handle.
        }
        queueMicrotask(() => exitSubscription.dispose());
        if (exitCode === 0) resolve({ exitCode, signal });
        else reject(new Error(
          `PTY host exited with ${signal ?? exitCode}.\n${diagnosticTail()}`
        ));
      });
    });
    await exit;
    const sessionProof = await verifyEmbeddedSession(root, options);

    const unchanged = draftBefore.equals(fs.readFileSync(draftPath));
    const restored = output.includes("CLAUDE_HOST:AFTER:");
    const terminalRestored = output.includes("\u001b[?1049l")
      && output.includes("\u001b[?25h");
    if (options.assertDraftUnchanged && !unchanged) {
      throw new Error(`Claude draft changed during PTY handoff.\n${diagnosticTail()}`);
    }
    if (options.assertCleanTerminal && !terminalRestored) {
      throw new Error(`Fleet did not emit terminal restoration controls.\n${diagnosticTail()}`);
    }
    const uninstallPreview = await previewUninstallSetup({
      pluginDataDir: setupPlan.pluginDataDir
    });
    await uninstallSetup({
      pluginDataDir: setupPlan.pluginDataDir,
      confirmationToken: uninstallPreview.confirmationToken
    });
    const restoredSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const uninstallRestored = restoredSettings.env?.EDITOR === originalEditor
      && !("VISUAL" in restoredSettings.env);
    return {
      schemaVersion: 1,
      pty: process.platform === "win32" ? "conpty" : "forkpty",
      editorOpened: output.includes("FAKE_EDITOR:OPEN"),
      returnedToHost: restored,
      draftUnchanged: unchanged,
      terminalRestored,
      installedLauncherChecked,
      installedLauncherHandoff: restored && output.includes("CONSOLE=0"),
      ...sessionProof,
      uninstallRestored,
      ownedChildrenAfterExit: isProcessAlive(ownedPid) ? 1 : 0
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await runPtySmoke(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  } catch (error) {
    process.stderr.write(`${error.message}\n`, () => process.exit(1));
  }
}
