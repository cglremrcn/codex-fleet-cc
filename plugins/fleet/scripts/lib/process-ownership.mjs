import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_IDENTITY_LENGTH = 256;

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function validIdentity(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTITY_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function observeLinuxStart(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const startTicks = fields[19];
    return startTicks ? `linux:${startTicks}` : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

async function observeWindowsStart(pid, env) {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("Windows process identity requires an absolute SystemRoot.");
  }
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-Process -Id ${pid}`,
    "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)"
  ].join(";");
  try {
    const { stdout } = await execFile(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4_096
    });
    const ticks = stdout.trim();
    return /^\d+$/u.test(ticks) ? `win32:${ticks}` : null;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === 1) return null;
    throw error;
  }
}

async function observeDarwinStart(pid) {
  try {
    const { stdout } = await execFile("/bin/ps", [
      "-o",
      "lstart=",
      "-p",
      String(pid)
    ], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4_096
    });
    const started = stdout.trim().replace(/\s+/gu, " ");
    return started ? `darwin:${started}` : null;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === 1) return null;
    throw error;
  }
}

export async function observeProcessStart(pid, options = {}) {
  if (!validPid(pid)) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return observeWindowsStart(pid, options.env ?? process.env);
  if (platform === "linux") return observeLinuxStart(pid);
  if (platform === "darwin") return observeDarwinStart(pid);
  throw new Error(`Unsupported process identity platform: ${platform}.`);
}

export async function captureOwnedProcess(pid, options = {}) {
  if (!validPid(pid)) throw new TypeError("Owned process PID must be a positive integer.");
  const observeStart = options.observeStart ?? observeProcessStart;
  const recordedStart = await observeStart(pid, options);
  if (!validIdentity(recordedStart)) {
    throw new Error("Owned process is not running or has no stable start identity.");
  }
  return Object.freeze({ pid, recordedStart });
}

export async function cancelOwnedProcess(record, options = {}) {
  if (!record || typeof record !== "object"
      || !validPid(record.pid) || !validIdentity(record.recordedStart)) {
    return Object.freeze({ cancelled: false, reason: "invalid-record" });
  }
  const observeStart = options.observeStart ?? observeProcessStart;
  const observedStart = await observeStart(record.pid, options);
  if (!validIdentity(observedStart)) {
    return Object.freeze({ cancelled: false, reason: "not-running" });
  }
  if (observedStart !== record.recordedStart) {
    return Object.freeze({ cancelled: false, reason: "ownership-mismatch" });
  }

  const kill = options.kill ?? process.kill;
  try {
    kill(record.pid, "SIGTERM");
    return Object.freeze({ cancelled: true, reason: "owned-process-stopped" });
  } catch (error) {
    if (error.code === "ESRCH") {
      return Object.freeze({ cancelled: false, reason: "not-running" });
    }
    if (error.code === "EPERM") {
      return Object.freeze({ cancelled: false, reason: "permission-denied" });
    }
    return Object.freeze({ cancelled: false, reason: "stop-failed" });
  }
}
