// Derived from openai/codex-plugin-cc at db52e28f4d9ded852ab3942cea316258ae4ef346.
// Modified for a single long-lived Fleet runtime and explicit executable resolution.
// Licensed under Apache-2.0; see ../../LICENSE and ../../NOTICE.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";

import {
  cancelOwnedProcess,
  captureOwnedProcess,
  observeProcessStart
} from "./lib/process-ownership.mjs";
import { terminateProcessTree } from "./lib/upstream/process.mjs";

export const BROKER_PROTOCOL_VERSION = 1;

const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GRACEFUL_CLOSE_MS = 1_000;
const DEFAULT_STOP_RECONCILIATION_MS = 250;
const WINDOWS_UNSAFE_BATCH_PATH = /[%!^&|<>\"]/;
const OWNERSHIP_REMEDIATION =
  "Re-run doctor; inspect the process through normal OS or app controls.";

const CLIENT_INFO = Object.freeze({
  title: "Codex Fleet",
  name: "Claude Code",
  version: "0.2.0"
});

const CAPABILITIES = Object.freeze({
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
});

function safeProtocolName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_./-]{1,120}$/u.test(value)
    ? value
    : null;
}

function safeProtocolKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => safeProtocolName(key)).sort().slice(0, 16);
}

function currentIdentityState(reason) {
  if (reason === "ownership-mismatch") return "different";
  if (reason === "permission-denied" || reason === "stop-failed") return "same";
  if (reason === "not-running") return "missing";
  return "unknown";
}

function ownershipRefusalError(record, reason) {
  const pid = Number.isSafeInteger(record?.pid) && record.pid > 0 ? record.pid : null;
  const error = new Error(
    `Fleet did not stop app-server PID ${String(pid ?? "unknown")}: ${reason}.`
  );
  error.code = "FLEET_BROKER_OWNERSHIP_REFUSED";
  error.diagnostic = Object.freeze({
    reasonCode: reason,
    action: "not_stopped",
    pid,
    recordedIdentityPresent: typeof record?.recordedStart === "string"
      && record.recordedStart.length > 0,
    currentIdentity: currentIdentityState(reason),
    remediation: OWNERSHIP_REMEDIATION
  });
  return error;
}

function requestFailure(method, message, requestAcceptance, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.requestMethod = method;
  error.requestAcceptance = requestAcceptance;
  return error;
}

export function summarizeProtocolMessage(message) {
  const serverRequest = message?.id !== undefined && Boolean(message?.method);
  const notification = message?.id === undefined && Boolean(message?.method);
  return Object.freeze({
    kind: serverRequest ? "serverRequest" : notification ? "notification" : "response",
    method: safeProtocolName(message?.method),
    turnStatus: safeProtocolName(message?.params?.turn?.status),
    itemType: safeProtocolName(message?.params?.item?.type),
    paramsKeys: safeProtocolKeys(message?.params),
    turnKeys: safeProtocolKeys(message?.params?.turn),
    hasError: Boolean(message?.error ?? message?.params?.turn?.error)
  });
}

export async function stopOwnedProcessTree(record, options = {}) {
  const stopTree = options.terminateProcessTree ?? terminateProcessTree;
  const outcome = await cancelOwnedProcess(record, {
    observeStart: options.observeStart,
    platform: options.platform,
    env: options.env,
    kill: (pid) => {
      const result = stopTree(pid, {
        platform: options.platform,
        env: options.env,
        cwd: options.cwd
      });
      if (!result?.delivered) {
        const error = new Error("Owned process is no longer running.");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  if (outcome.reason !== "stop-failed") return outcome;

  const waitForStopReconciliation = options.waitForStopReconciliation
    ?? ((delayMs) => new Promise((resolve) => {
      const timeout = setTimeout(resolve, delayMs);
      timeout.unref?.();
    }));
  await waitForStopReconciliation(
    options.stopReconciliationMs ?? DEFAULT_STOP_RECONCILIATION_MS
  );
  const observeStart = options.observeStart ?? observeProcessStart;
  const currentStart = await observeStart(record.pid, {
    platform: options.platform,
    env: options.env
  });
  if (!currentStart) {
    return Object.freeze({ cancelled: false, reason: "not-running" });
  }
  if (currentStart !== record.recordedStart) {
    return Object.freeze({ cancelled: false, reason: "ownership-mismatch" });
  }
  return outcome;
}

function candidateExtensions(platform, env, command) {
  if (platform !== "win32" || path.extname(command)) {
    return [""];
  }
  const configured = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  return [...new Set([...configured, ""])];
}

function isExecutableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveExecutable(command, options = {}) {
  if (typeof command !== "string" || command.trim() !== command || !command) {
    throw new TypeError("Codex executable must be a non-empty command name or absolute path.");
  }

  if (path.isAbsolute(command)) {
    if (!isExecutableFile(command)) {
      throw new Error(`Codex executable does not exist: ${command}`);
    }
    return path.normalize(command);
  }

  if (command.includes("/") || command.includes("\\")) {
    throw new Error("Relative Codex executable paths are not allowed.");
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of String(pathValue).split(delimiter).filter(Boolean)) {
    for (const extension of candidateExtensions(platform, env, command)) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(`Codex executable was not found on PATH: ${command}`);
}

function buildSpawnSpec(codexCommand, options = {}) {
  const configured = typeof codexCommand === "string"
    ? { executable: codexCommand, args: [] }
    : codexCommand;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new TypeError("codexCommand must be a command string or executable descriptor.");
  }
  if (!Array.isArray(configured.args) || configured.args.some((value) => typeof value !== "string")) {
    throw new TypeError("codexCommand.args must be an array of strings.");
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = resolveExecutable(configured.executable, { env, platform });
  const args = [...configured.args, "app-server"];
  const extension = path.extname(executable).toLowerCase();

  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    if (WINDOWS_UNSAFE_BATCH_PATH.test(executable)) {
      throw new Error("Codex batch wrapper path contains characters unsafe for cmd.exe.");
    }
    if (configured.args.length > 0) {
      throw new Error("Codex batch wrappers cannot be combined with configured prefix arguments.");
    }
    const commandProcessor = env.ComSpec ?? env.COMSPEC;
    if (!commandProcessor || !path.isAbsolute(commandProcessor)) {
      throw new Error("A trusted absolute ComSpec path is required for Codex batch wrappers.");
    }
    return {
      executable,
      args: ["app-server"],
      shell: commandProcessor
    };
  }

  return { executable, args, shell: false };
}

class AppServerBroker {
  constructor(options) {
    this.options = options;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.eventHandler = null;
    this.exitError = null;
    this.protocolVersion = BROKER_PROTOCOL_VERSION;
    this.captureOwnedProcess = options.captureOwnedProcess ?? captureOwnedProcess;
    this.stopOwnedProcessTree = options.stopOwnedProcessTree ?? stopOwnedProcessTree;
  }

  async start() {
    const spawnSpec = buildSpawnSpec(this.options.codexCommand ?? "codex", this.options);
    this.child = spawn(spawnSpec.executable, spawnSpec.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      detached: process.platform !== "win32",
      shell: spawnSpec.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.once("error", (error) => this.handleExit(error));
    this.child.once("exit", (code, signal) => {
      const error = code === 0 || this.closed
        ? null
        : new Error(
            `Codex app-server exited ${signal ? `with signal ${signal}` : `with code ${code}`}.`
          );
      this.handleExit(error);
    });

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    try {
      this.ownedProcess = await this.captureOwnedProcess(this.child.pid, {
        env: this.options.env ?? process.env
      });
    } catch (error) {
      this.closed = true;
      this.child.kill("SIGTERM");
      await this.exitPromise;
      throw new Error("Could not establish ownership of the Codex app-server process.", {
        cause: error
      });
    }

    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: CAPABILITIES
    });
    this.notify("initialized", {});
    return this;
  }

  setEventHandler(handler) {
    if (handler !== null && typeof handler !== "function") {
      throw new TypeError("Broker event handler must be a function or null.");
    }
    this.eventHandler = handler;
  }

  request(method, params, options = {}) {
    if (this.closed || !this.child?.stdin?.writable) {
      return Promise.reject(requestFailure(
        method,
        "Codex app-server broker is closed.",
        "not_sent"
      ));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs
      ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: null, method, sent: false };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(requestFailure(
          method,
          `Codex app-server request timed out: ${method}.`,
          pending.sent ? "unknown" : "not_sent"
        ));
      }, timeoutMs);
      timeout.unref?.();
      pending.timeout = timeout;
      this.pending.set(id, pending);
      try {
        this.send({ id, method, params });
        pending.sent = true;
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(requestFailure(
          method,
          `Codex app-server request was not sent: ${method}.`,
          "not_sent",
          error
        ));
      }
    });
  }

  notify(method, params) {
    if (!this.closed) {
      this.send({ method, params });
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      this.handleExit(new Error("Codex app-server emitted an oversized JSONL message."));
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(new Error(`Codex app-server emitted invalid JSONL: ${error.message}`));
      return;
    }

    try {
      this.options.onProtocolMessage?.(summarizeProtocolMessage(message));
    } catch {
      // Diagnostics cannot alter the broker state machine.
    }

    if (message.id !== undefined && message.method) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` }
      });
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        const error = new Error(message.error.message ?? `${pending.method} failed.`);
        error.rpcCode = message.error.code;
        error.data = message.error.data;
        error.requestMethod = pending.method;
        error.requestAcceptance = "rejected";
        pending.reject(error);
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      this.eventHandler?.(message);
    }
  }

  handleExit(error) {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitError = error ?? null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(requestFailure(
        pending.method,
        error?.message ?? "Codex app-server broker exited.",
        pending.sent ? "unknown" : "not_sent",
        error ?? undefined
      ));
    }
    this.pending.clear();
    this.resolveExit?.();
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeBroker();
    return this.closePromise;
  }

  async closeBroker() {
    this.lines?.close();
    this.child?.stdin?.end();
    const gracefulExit = await this.waitForExit(
      this.options.gracefulCloseMs ?? DEFAULT_GRACEFUL_CLOSE_MS
    );
    let refusal = null;
    try {
      if (!gracefulExit && !this.exited && Number.isFinite(this.child?.pid)) {
        const outcome = await this.stopOwnedProcessTree(this.ownedProcess, {
          env: this.options.env,
          cwd: this.options.cwd,
          platform: process.platform
        });
        if (!outcome.cancelled && outcome.reason !== "not-running") {
          refusal = ownershipRefusalError(this.ownedProcess, outcome.reason);
        }
      }
    } catch (error) {
      refusal = error?.code === "FLEET_BROKER_OWNERSHIP_REFUSED"
        ? error
        : ownershipRefusalError(this.ownedProcess, "stop-failed");
    } finally {
      this.child?.stdin?.destroy();
    }

    if (refusal) {
      this.child?.stdout?.destroy();
      this.child?.stderr?.destroy();
      this.child?.unref?.();
      throw refusal;
    }

    const exited = gracefulExit || await this.waitForExit(5_000);
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    if (!exited) {
      this.child?.unref?.();
      throw new Error("Owned Codex app-server did not exit after termination.");
    }
  }

  async waitForExit(timeoutMs) {
    if (this.exited) return true;
    let timeout;
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      })
    ]);
    clearTimeout(timeout);
    return exited;
  }
}

export async function createAppServerBroker(options = {}) {
  const broker = new AppServerBroker(options);
  return broker.start();
}
