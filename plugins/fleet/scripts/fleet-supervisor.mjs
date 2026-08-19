#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { normalizeAuthority } from "./lib/authority.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { resolveOwnedPath } from "./lib/paths.mjs";
import { captureOwnedProcess } from "./lib/process-ownership.mjs";
import { createRuntime } from "./lib/runtime-adapter.mjs";
import { readWorkspaceState, writeWorkspaceState } from "./lib/safe-state.mjs";
import { createScheduler } from "./lib/scheduler.mjs";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  createSupervisorServer,
  supervisorPaths
} from "./lib/supervisor-protocol.mjs";

const MAX_FOLLOW_UP_LENGTH = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertSafeId(value, label) {
  if (!SAFE_ID.test(value ?? "")) {
    throw new TypeError(`${label} must be a 1-64 character URL-safe identifier.`);
  }
  return value;
}

function assertMessage(value) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > MAX_FOLLOW_UP_LENGTH
    || value.includes("\0")
  ) {
    throw new TypeError("Follow-up message must contain 1-131072 characters without null bytes.");
  }
  return value;
}

function hasConfirmationAction(authority) {
  return authority.sandbox === "workspace-write"
    || authority.browser.mutate
    || Object.values(authority.externalEffects).some(Boolean);
}

function validateStartContract(contract, workspacePath) {
  assertObject(contract, "Fleet start contract");
  if (contract.schemaVersion !== 1 || path.resolve(contract.workspacePath ?? "") !== workspacePath) {
    throw new Error("Fleet start contract workspace identity mismatch.");
  }
  if (!Array.isArray(contract.lanes) || contract.lanes.length === 0 || contract.lanes.length > 256) {
    throw new TypeError("Fleet start contract must contain between 1 and 256 lanes.");
  }
  const lanes = contract.lanes.map((lane) => {
    assertObject(lane, "Fleet lane contract");
    const authority = normalizeAuthority(lane.authority);
    if (!authority.process.start) {
      throw new Error(`Lane ${String(lane.id)} lacks process start authority.`);
    }
    if (hasConfirmationAction(authority) && !contract.confirmationRef) {
      throw new Error(`Lane ${String(lane.id)} requires a confirmation reference.`);
    }
    return { ...lane, authority };
  });
  return Object.freeze({ ...contract, lanes });
}

function serializeStateStore(root) {
  let writes = Promise.resolve();
  return {
    write(snapshot) {
      const state = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        lanes: [...snapshot.queued, ...snapshot.active, ...snapshot.history]
      };
      writes = writes.then(() => writeWorkspaceState(root, state));
      return writes;
    }
  };
}

function flattenSnapshot(snapshot) {
  return [...snapshot.queued, ...snapshot.active, ...snapshot.history];
}

function cancelDigest(token, workspaceKey, lane) {
  return crypto.createHmac("sha256", Buffer.from(token, "hex"))
    .update(JSON.stringify({
      schemaVersion: 1,
      workspaceKey,
      laneId: lane.id,
      threadId: lane.threadId ?? null,
      turnId: lane.turnId ?? null
    }))
    .digest("hex");
}

function secureDigestMatches(expected, received) {
  if (!/^[a-f0-9]{64}$/u.test(received ?? "")) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

function createControlPlane(options) {
  const root = resolveOwnedPath(options.dataDir, "workspaces", options.workspaceKey);
  let runtime = null;
  let scheduler = null;
  let reconcileTimer = null;
  let reconciling = null;

  async function ensureScheduler(limits) {
    if (scheduler) return scheduler;
    const state = await readWorkspaceState(root);
    runtime = await (options.createRuntime ?? createRuntime)({
      cwd: options.workspacePath,
      env: options.env ?? process.env
    });
    scheduler = createScheduler({
      runtime,
      store: serializeStateStore(root),
      limits,
      workspacePath: options.workspacePath,
      initialRecords: state.lanes
    });
    return scheduler;
  }

  async function reconcile() {
    if (!scheduler) return null;
    if (reconciling) return reconciling;
    reconciling = scheduler.reconcile().finally(() => {
      reconciling = null;
    });
    return reconciling;
  }

  function monitorActive() {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(() => {
      void reconcile().then((snapshot) => {
        if (snapshot && snapshot.queued.length === 0 && snapshot.active.length === 0) {
          clearInterval(reconcileTimer);
          reconcileTimer = null;
          options.onIdle?.();
        }
      }).catch(() => {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
        options.onIdle?.();
      });
    }, 50);
  }

  async function snapshot() {
    if (scheduler) {
      await reconcile();
      return scheduler.snapshot();
    }
    const state = await readWorkspaceState(root);
    return {
      schemaVersion: 1,
      queued: [],
      active: [],
      history: state.lanes
    };
  }

  async function findMutableLane(laneId) {
    const current = await snapshot();
    return flattenSnapshot(current).find((lane) => lane.id === laneId) ?? null;
  }

  return Object.freeze({
    async handle(method, params) {
      if (method === "ping") {
        const current = await snapshot();
        return { ready: true, active: current.active.length };
      }
      if (method === "status") {
        const current = await snapshot();
        return {
          schemaVersion: 1,
          workspaceKey: options.workspaceKey,
          lanes: flattenSnapshot(current)
        };
      }
      if (method === "result") {
        const laneId = assertSafeId(params.laneId, "Result lane id");
        const lane = await findMutableLane(laneId);
        if (!lane) throw new Error(`Lane result was not found: ${laneId}.`);
        return lane;
      }
      if (method === "start") {
        options.onActivity?.();
        const contract = validateStartContract(params, options.workspacePath);
        const owner = await ensureScheduler(contract.limits);
        const admissions = contract.lanes.map((lane) => owner.enqueue({
          ...lane,
          workspacePath: options.workspacePath,
          workspaceKey: options.workspaceKey,
          checkoutKey: lane.checkoutKey ?? options.workspaceKey
        }));
        const lanes = await Promise.all(admissions);
        monitorActive();
        return { schemaVersion: 1, background: true, lanes };
      }
      if (method === "followUp") {
        options.onActivity?.();
        const laneId = assertSafeId(params.laneId, "Follow-up lane id");
        const owner = await ensureScheduler();
        const lane = await owner.continue(laneId, assertMessage(params.message));
        monitorActive();
        return lane;
      }
      if (method === "cancel") {
        options.onActivity?.();
        const laneId = assertSafeId(params.laneId, "Cancellation lane id");
        const owner = await ensureScheduler();
        const lane = await findMutableLane(laneId);
        if (!lane || !["queued", "starting", "running"].includes(lane.status)) {
          throw new Error(`Lane is not queued or active: ${laneId}.`);
        }
        const expected = cancelDigest(options.token, options.workspaceKey, lane);
        if (!params.confirmationToken) {
          return {
            schemaVersion: 1,
            writesPerformed: false,
            laneId,
            expectedThreadId: lane.threadId ?? null,
            expectedTurnId: lane.turnId ?? null,
            confirmationToken: expected
          };
        }
        if (
          params.expectedThreadId !== (lane.threadId ?? null)
          || params.expectedTurnId !== (lane.turnId ?? null)
          || !secureDigestMatches(expected, params.confirmationToken)
        ) {
          throw new Error("Cancellation confirmation or target identity changed.");
        }
        await owner.cancel(laneId, {
          threadId: lane.threadId ?? null,
          turnId: lane.turnId ?? null
        });
        monitorActive();
        return { schemaVersion: 1, accepted: true, laneId };
      }
      throw new Error(`Unknown Fleet supervisor method: ${method}.`);
    },
    async restoreIdlePolicy() {
      const current = await snapshot();
      if (current.queued.length === 0 && current.active.length === 0) {
        options.onIdle?.();
      } else {
        monitorActive();
      }
    },
    async close() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      await reconcile().catch(() => undefined);
      await runtime?.close();
      runtime = null;
      scheduler = null;
    }
  });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Fleet supervisor arguments must be key/value pairs.");
    }
    if (values.has(key)) throw new Error(`Duplicate Fleet supervisor argument: ${key}.`);
    values.set(key, value);
  }
  const required = ["--data-dir", "--workspace-key", "--workspace-path"];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`Missing Fleet supervisor argument: ${key}.`);
  }
  return Object.freeze({
    dataDir: values.get("--data-dir"),
    workspaceKey: values.get("--workspace-key"),
    workspacePath: values.get("--workspace-path")
  });
}

async function writeManifest(paths, manifest) {
  const temporaryPath = path.join(
    paths.root,
    `.supervisor-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await fs.rename(temporaryPath, paths.manifestPath);
}

export async function runSupervisor(options = {}) {
  const dataDir = path.resolve(options.dataDir);
  const workspacePath = path.resolve(options.workspacePath);
  const workspaceKey = options.workspaceKey;
  const paths = supervisorPaths({ dataDir, workspaceKey });
  const token = crypto.randomBytes(32).toString("hex");
  const ownedProcess = await captureOwnedProcess(process.pid, options);
  let closing = false;
  let idleTimer = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  function cancelIdleShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleShutdown(delayMs = 750) {
    cancelIdleShutdown();
    idleTimer = setTimeout(() => void close(), delayMs);
  }

  const control = createControlPlane({
    dataDir,
    workspaceKey,
    workspacePath,
    token,
    env: options.env ?? process.env,
    createRuntime: options.createRuntime,
    onActivity: cancelIdleShutdown,
    onIdle: scheduleIdleShutdown
  });

  const server = await createSupervisorServer({
    ...paths,
    workspaceKey,
    token,
    handleRequest: async ({ method, params }) => {
      if (method === "shutdown") {
        setTimeout(() => close(), 50).unref?.();
        return { accepted: true };
      }
      try {
        return await control.handle(method, params);
      } catch (error) {
        await control.restoreIdlePolicy().catch(() => undefined);
        throw error;
      }
    }
  });

  const manifest = Object.freeze({
    schemaVersion: 1,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    workspaceKey,
    address: paths.address,
    token,
    process: ownedProcess
  });

  async function close() {
    if (closing) return stopped;
    closing = true;
    cancelIdleShutdown();
    await control.close().catch(() => undefined);
    process.chdir(path.dirname(process.execPath));
    await server.close().catch(() => undefined);
    try {
      const current = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
      if (
        current?.token === token
        && current?.process?.pid === ownedProcess.pid
        && current?.process?.recordedStart === ownedProcess.recordedStart
      ) {
        await fs.unlink(paths.manifestPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      resolveStopped();
    }
    return stopped;
  }

  await writeManifest(paths, manifest);
  scheduleIdleShutdown(2_000);
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await stopped;
}

if (isMainModule(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  await runSupervisor(options);
}
