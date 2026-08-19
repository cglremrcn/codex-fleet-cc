import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  captureOwnedProcess,
  observeProcessStart
} from "./process-ownership.mjs";

export const MAX_SUPERVISOR_MESSAGE_BYTES = 256 * 1024;
export const SUPERVISOR_PROTOCOL_VERSION = 1;

const WORKSPACE_KEY = /^[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const MAX_PORTABLE_SOCKET_BYTES = 99;
const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "requestId",
  "token",
  "workspaceKey",
  "method",
  "params"
]);

function assertAbsoluteDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("Supervisor data directory must be absolute.");
  }
  return path.resolve(value);
}

function assertWorkspaceKey(value) {
  if (!WORKSPACE_KEY.test(value ?? "")) {
    throw new TypeError("Supervisor workspace key must be a 32-character lowercase hex digest.");
  }
  return value;
}

function boundedSafeText(value, label, maximum = 128) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must contain between 1 and ${maximum} safe characters.`);
  }
  return value;
}

function safeErrorMessage(error) {
  return String(error?.message ?? "Supervisor request failed.")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 512);
}

function tokenMatches(expected, received) {
  if (!TOKEN.test(expected ?? "") || !TOKEN.test(received ?? "")) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

function encodeMessage(value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
    throw new Error(`Supervisor message exceeds ${MAX_SUPERVISOR_MESSAGE_BYTES} bytes.`);
  }
  return serialized;
}

function parseRequest(serialized, options) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Supervisor request must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supervisor request must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(key)) throw new Error(`Unknown supervisor request field: ${key}.`);
  }
  if (value.schemaVersion !== SUPERVISOR_PROTOCOL_VERSION) {
    throw new Error("Supervisor protocol version mismatch.");
  }
  boundedSafeText(value.requestId, "Supervisor request id", 128);
  boundedSafeText(value.method, "Supervisor method", 64);
  if (value.workspaceKey !== options.workspaceKey) {
    throw new Error("Supervisor workspace mismatch.");
  }
  if (!tokenMatches(options.token, value.token)) {
    throw new Error("Supervisor authentication failed.");
  }
  if (!value.params || typeof value.params !== "object" || Array.isArray(value.params)) {
    throw new Error("Supervisor params must be an object.");
  }
  return value;
}

async function ensurePrivateRoot(root) {
  const boundary = path.dirname(path.dirname(root));
  const relative = path.relative(boundary, root);
  let current = boundary;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = segment ? path.join(current, segment) : current;
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error("Supervisor path cannot contain a symbolic link.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    const metadata = await fs.lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Supervisor root must be a non-symbolic-link directory.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(root, 0o700).catch((error) => {
    if (process.platform !== "win32") throw error;
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateProcessRecord(value) {
  if (
    !value
    || typeof value !== "object"
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.recordedStart !== "string"
    || value.recordedStart.length === 0
    || value.recordedStart.length > 256
  ) {
    throw new Error("Supervisor manifest has an invalid process identity.");
  }
  return Object.freeze({ pid: value.pid, recordedStart: value.recordedStart });
}

function validateManifest(value, paths, workspaceKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supervisor manifest must be an object.");
  }
  if (
    value.schemaVersion !== 1
    || value.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION
    || value.workspaceKey !== workspaceKey
    || value.address !== paths.address
    || !TOKEN.test(value.token ?? "")
  ) {
    throw new Error("Supervisor manifest identity mismatch.");
  }
  return Object.freeze({
    schemaVersion: 1,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    workspaceKey,
    address: paths.address,
    token: value.token,
    process: validateProcessRecord(value.process),
    manifestPath: paths.manifestPath
  });
}

async function readJsonFile(filePath, maximumBytes) {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error("Supervisor metadata must be a bounded regular file.");
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function readSupervisorManifest(options = {}) {
  const paths = supervisorPaths(options);
  try {
    return validateManifest(
      await readJsonFile(paths.manifestPath, MAX_MANIFEST_BYTES),
      paths,
      options.workspaceKey
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function connectExisting(options, paths) {
  const manifest = await readSupervisorManifest(options);
  if (!manifest) return null;
  const observedStart = await observeProcessStart(manifest.process.pid, options);
  if (observedStart !== manifest.process.recordedStart) {
    return Object.freeze({ stale: true, manifest });
  }
  try {
    await requestSupervisor({
      address: manifest.address,
      workspaceKey: manifest.workspaceKey,
      token: manifest.token,
      method: "ping",
      params: {},
      timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS, 2_000)
    });
    return Object.freeze({ stale: false, manifest });
  } catch (error) {
    throw new Error(
      `Supervisor process identity is live but its control channel is unavailable: ${safeErrorMessage(error)}`
    );
  }
}

async function removeStaleMetadata(paths) {
  await fs.unlink(paths.manifestPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (process.platform !== "win32") {
    await fs.unlink(paths.address).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function tryAcquireStartupLock(paths, options) {
  try {
    const handle = await fs.open(paths.lockPath, "wx", 0o600);
    const owner = await captureOwnedProcess(process.pid, options);
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, process: owner }), "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return null;
  }
}

async function clearStaleStartupLock(paths, options) {
  try {
    const lock = await readJsonFile(paths.lockPath, MAX_MANIFEST_BYTES);
    const owner = validateProcessRecord(lock?.process);
    const observedStart = await observeProcessStart(owner.pid, options);
    if (observedStart === owner.recordedStart) return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    const metadata = await fs.lstat(paths.lockPath).catch(() => null);
    if (metadata && Date.now() - metadata.mtimeMs < 2_000) return false;
  }
  await fs.unlink(paths.lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

export function supervisorPaths(options = {}) {
  const dataDir = assertAbsoluteDirectory(options.dataDir);
  const workspaceKey = assertWorkspaceKey(options.workspaceKey);
  const platform = options.platform ?? process.platform;
  const root = path.join(dataDir, "supervisors", workspaceKey);
  const endpointHash = crypto.createHash("sha256")
    .update(`${dataDir}\0${workspaceKey}`)
    .digest("hex")
    .slice(0, 32);
  let address;
  if (platform === "win32") {
    address = `\\\\.\\pipe\\codex-fleet-${endpointHash}`;
  } else {
    const socketName = `cfx-${endpointHash}.sock`;
    address = path.join(os.tmpdir(), socketName);
    if (Buffer.byteLength(address, "utf8") > MAX_PORTABLE_SOCKET_BYTES) {
      address = path.join(path.parse(os.tmpdir()).root, "tmp", socketName);
    }
    if (Buffer.byteLength(address, "utf8") > MAX_PORTABLE_SOCKET_BYTES) {
      throw new Error("Supervisor socket path exceeds the portable Unix-domain limit.");
    }
  }
  return Object.freeze({
    root,
    address,
    manifestPath: path.join(root, "supervisor.json"),
    lockPath: path.join(root, "startup.lock")
  });
}

export async function createSupervisorServer(options = {}) {
  const address = boundedSafeText(options.address, "Supervisor address", 512);
  const workspaceKey = assertWorkspaceKey(options.workspaceKey);
  if (!TOKEN.test(options.token ?? "")) {
    throw new TypeError("Supervisor token must be a 64-character lowercase hex value.");
  }
  if (typeof options.handleRequest !== "function") {
    throw new TypeError("Supervisor request handler is required.");
  }
  await ensurePrivateRoot(assertAbsoluteDirectory(options.root));

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > MAX_SUPERVISOR_MESSAGE_BYTES) {
        handled = true;
        socket.end(encodeMessage({
          schemaVersion: 1,
          requestId: "unknown",
          ok: false,
          error: "Supervisor message exceeds the protocol limit."
        }));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      handled = true;
      let requestId = "unknown";
      try {
        const serialized = buffered.subarray(0, newline).toString("utf8");
        const envelope = JSON.parse(serialized);
        if (typeof envelope?.requestId === "string" && envelope.requestId.length <= 128) {
          requestId = envelope.requestId;
        }
        const request = parseRequest(serialized, {
          workspaceKey,
          token: options.token
        });
        requestId = request.requestId;
        const result = await options.handleRequest(request);
        socket.end(encodeMessage({ schemaVersion: 1, requestId, ok: true, result }));
      } catch (error) {
        socket.end(encodeMessage({
          schemaVersion: 1,
          requestId,
          ok: false,
          error: safeErrorMessage(error)
        }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await fs.chmod(address, 0o600);

  return Object.freeze({
    address,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (process.platform !== "win32") {
        await fs.unlink(address).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  });
}

export async function requestSupervisor(options = {}) {
  const requestId = options.requestId ?? crypto.randomUUID();
  const request = {
    schemaVersion: SUPERVISOR_PROTOCOL_VERSION,
    requestId,
    token: options.token,
    workspaceKey: options.workspaceKey,
    method: options.method,
    params: options.params ?? {}
  };
  const serialized = encodeMessage(request);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(options.address);
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error("Supervisor request timed out.")),
      timeoutMs
    );
    timer.unref?.();
    socket.once("connect", () => socket.write(serialized));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > MAX_SUPERVISOR_MESSAGE_BYTES) {
        finish(new Error("Supervisor response exceeds the protocol limit."));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
        if (response.schemaVersion !== 1 || response.requestId !== requestId) {
          throw new Error("Supervisor response identity mismatch.");
        }
        if (response.ok !== true) throw new Error(response.error ?? "Supervisor request failed.");
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

export async function ensureSupervisor(options = {}) {
  const paths = supervisorPaths(options);
  const workspacePath = assertAbsoluteDirectory(options.workspacePath);
  const scriptPath = path.resolve(options.scriptPath);
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  await ensurePrivateRoot(paths.root);

  const initial = await connectExisting(options, paths);
  if (initial && !initial.stale) return initial.manifest;
  if (initial?.stale) await removeStaleMetadata(paths);

  const deadline = Date.now() + timeoutMs;
  let lockHandle = null;
  while (!lockHandle && Date.now() < deadline) {
    lockHandle = await tryAcquireStartupLock(paths, options);
    if (lockHandle) break;
    const existing = await connectExisting(options, paths);
    if (existing && !existing.stale) return existing.manifest;
    if (existing?.stale) await removeStaleMetadata(paths);
    await clearStaleStartupLock(paths, options);
    await delay(50);
  }
  if (!lockHandle) throw new Error("Timed out waiting for the Fleet supervisor startup lock.");

  try {
    const existing = await connectExisting(options, paths);
    if (existing && !existing.stale) return existing.manifest;
    if (existing?.stale) await removeStaleMetadata(paths);

    const child = spawn(nodeExecutable, [
      scriptPath,
      "--data-dir",
      path.resolve(options.dataDir),
      "--workspace-key",
      options.workspaceKey,
      "--workspace-path",
      workspacePath
    ], {
      cwd: workspacePath,
      detached: true,
      env: options.env ?? process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    while (Date.now() < deadline) {
      const ready = await connectExisting(options, paths).catch((error) => {
        if (/control channel is unavailable/iu.test(error.message)) return null;
        throw error;
      });
      if (ready && !ready.stale) return ready.manifest;
      if (child.exitCode !== null) {
        throw new Error(`Fleet supervisor exited before becoming ready (${child.exitCode}).`);
      }
      await delay(50);
    }
    throw new Error("Fleet supervisor did not become ready before the startup deadline.");
  } finally {
    await lockHandle.close().catch(() => undefined);
    await fs.unlink(paths.lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function stopSupervisor(options = {}) {
  const manifest = options.manifest ?? await readSupervisorManifest(options);
  if (!manifest) return Object.freeze({ stopped: true, reason: "not-running" });
  const observeStart = options.observeStart ?? observeProcessStart;
  const observedStart = await observeStart(manifest.process.pid, options);
  if (observedStart !== manifest.process.recordedStart) {
    return Object.freeze({
      stopped: true,
      reason: observedStart === null ? "not-running" : "owned-process-gone"
    });
  }
  await requestSupervisor({
    address: manifest.address,
    workspaceKey: manifest.workspaceKey,
    token: manifest.token,
    method: "shutdown",
    params: {},
    timeoutMs: options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  });

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const current = await observeStart(manifest.process.pid, options);
    if (current !== manifest.process.recordedStart) {
      return Object.freeze({ stopped: true, reason: "owned-supervisor-stopped" });
    }
    await delay(50);
  }
  return Object.freeze({ stopped: false, reason: "shutdown-timeout" });
}
