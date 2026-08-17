import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeLaneForPersistence } from "./redaction.mjs";

export const MAX_LANES = 256;
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

const STATE_FILE = "state.json";
const LOCK_FILE = "state.lock";

function emptyState() {
  return { schemaVersion: 1, lanes: [], updatedAt: null };
}

function assertStateShape(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Fleet state must be an object.");
  }
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported fleet state schema version: ${String(state.schemaVersion)}.`);
  }
  if (!Array.isArray(state.lanes)) {
    throw new TypeError("Fleet state lanes must be an array.");
  }
  if (state.lanes.length > MAX_LANES) {
    throw new Error(`Fleet state exceeds the ${MAX_LANES} lane limit.`);
  }
}

function assertSize(serialized) {
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > MAX_STATE_BYTES) {
    throw new Error(`Fleet state size exceeds the ${MAX_STATE_BYTES} byte limit.`);
  }
}

async function ensureSafeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("Workspace state root must be an absolute path.");
  }

  const boundary = path.dirname(root);
  const relative = path.relative(boundary, root);
  let current = boundary;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = segment ? path.join(current, segment) : current;
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error("Workspace state path cannot contain a symbolic link.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  try {
    const existing = await fs.lstat(root);
    if (existing.isSymbolicLink()) {
      throw new Error("Workspace state root cannot be a symbolic link.");
    }
    if (!existing.isDirectory()) {
      throw new Error("Workspace state root must be a directory.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(root, 0o700).catch((error) => {
    if (process.platform !== "win32") {
      throw error;
    }
  });
}

async function acquireLock(root) {
  const lockPath = path.join(root, LOCK_FILE);
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    return { handle, lockPath };
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Fleet state is locked by another writer.");
    }
    throw error;
  }
}

async function releaseLock(lock) {
  await lock.handle.close().catch(() => undefined);
  await fs.unlink(lock.lockPath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function serializeState(state) {
  assertStateShape(state);
  assertSize(JSON.stringify(state));
  const safe = {
    schemaVersion: 1,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
    lanes: state.lanes.map(sanitizeLaneForPersistence)
  };
  const serialized = `${JSON.stringify(safe, null, 2)}\n`;
  assertSize(serialized);
  return serialized;
}

export async function writeWorkspaceState(root, state) {
  await ensureSafeRoot(root);
  const serialized = serializeState(state);
  const lock = await acquireLock(root);
  const temporaryPath = path.join(root, `.state-${process.pid}-${crypto.randomUUID()}.tmp`);
  let temporaryHandle;

  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(serialized, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await fs.rename(temporaryPath, path.join(root, STATE_FILE));
    await fs.chmod(path.join(root, STATE_FILE), 0o600).catch((error) => {
      if (process.platform !== "win32") {
        throw error;
      }
    });
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await releaseLock(lock);
  }
}

export async function readWorkspaceState(root, options = {}) {
  await ensureSafeRoot(root);
  const statePath = path.join(root, STATE_FILE);
  let metadata;
  try {
    metadata = await fs.lstat(statePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }

  if (metadata.isSymbolicLink()) {
    throw new Error("Fleet state file cannot be a symbolic link.");
  }
  if (!metadata.isFile()) {
    throw new Error("Fleet state path must be a regular file.");
  }
  if (metadata.size > MAX_STATE_BYTES) {
    throw new Error(`Fleet state size exceeds the ${MAX_STATE_BYTES} byte limit.`);
  }

  const serialized = await fs.readFile(statePath, "utf8");
  try {
    const state = JSON.parse(serialized);
    assertStateShape(state);
    return state;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const timestamp = (options.now ?? Date.now)();
    const quarantinePath = path.join(root, `state.corrupt-${timestamp}.json`);
    await fs.rename(statePath, quarantinePath);
    return emptyState();
  }
}
