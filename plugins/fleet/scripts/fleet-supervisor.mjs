#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./lib/is-main.mjs";
import { resolveOwnedPath } from "./lib/paths.mjs";
import { captureOwnedProcess } from "./lib/process-ownership.mjs";
import { createRuntime } from "./lib/runtime-adapter.mjs";
import { readWorkspaceState, writeWorkspaceState } from "./lib/safe-state.mjs";
import { createScheduler, recoverPersistedRecords } from "./lib/scheduler.mjs";
import { validateStartContract } from "./lib/start-contract.mjs";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  createSupervisorServer,
  supervisorPaths
} from "./lib/supervisor-protocol.mjs";

const MAX_FOLLOW_UP_LENGTH = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function idleShutdownDelay(env) {
  const value = env.FLEET_SUPERVISOR_IDLE_MS;
  if (value === undefined) return 5_000;
  if (!/^\d{3,5}$/u.test(value)) {
    throw new Error("FLEET_SUPERVISOR_IDLE_MS must be an integer between 750 and 60000.");
  }
  const milliseconds = Number(value);
  if (milliseconds < 750 || milliseconds > 60_000) {
    throw new Error("FLEET_SUPERVISOR_IDLE_MS must be an integer between 750 and 60000.");
  }
  return milliseconds;
}

export function createShutdownGuard() {
  let closing = false;
  let activeRequests = 0;
  let activityVersion = 0;
  let drainWaiters = [];
  return Object.freeze({
    admit() {
      if (closing) throw new Error("Fleet supervisor is shutting down.");
      activeRequests += 1;
      activityVersion += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeRequests -= 1;
        if (activeRequests === 0) {
          const waiters = drainWaiters;
          drainWaiters = [];
          for (const resolve of waiters) resolve();
        }
      };
    },
    armIdleClose() {
      return activityVersion;
    },
    tryIdleClose(expectedVersion) {
      if (closing || activeRequests > 0 || expectedVersion !== activityVersion) return false;
      closing = true;
      return true;
    },
    forceClose() {
      if (closing) return false;
      closing = true;
      return true;
    },
    isClosing() {
      return closing;
    },
    waitForDrained() {
      if (activeRequests === 0) return Promise.resolve();
      return new Promise((resolve) => drainWaiters.push(resolve));
    }
  });
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

export function createControlPlane(options) {
  const root = resolveOwnedPath(options.dataDir, "workspaces", options.workspaceKey);
  let runtime = null;
  let scheduler = null;
  let schedulerInitialization = null;
  let reconcileTimer = null;
  let reconciling = null;
  let recoveringPersisted = null;

  async function ensureScheduler(limits) {
    if (scheduler) return scheduler;
    if (schedulerInitialization) return schedulerInitialization;
    schedulerInitialization = (async () => {
      if (recoveringPersisted) await recoveringPersisted;
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
    })().finally(() => {
      schedulerInitialization = null;
    });
    return schedulerInitialization;
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
        const current = scheduler?.snapshot() ?? snapshot;
        if (current && current.queued.length === 0 && current.active.length === 0) {
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
    if (schedulerInitialization) await schedulerInitialization;
    if (scheduler) {
      await reconcile();
      return scheduler.snapshot();
    }
    if (recoveringPersisted) return recoveringPersisted;
    recoveringPersisted = (async () => {
      const state = await readWorkspaceState(root);
      const history = recoverPersistedRecords(state.lanes);
      const changed = history.some((lane, index) => lane.status !== state.lanes[index]?.status);
      if (changed) {
        await writeWorkspaceState(root, {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          lanes: history
        });
      }
      return {
        schemaVersion: 1,
        queued: [],
        active: [],
        history
      };
    })().finally(() => {
      recoveringPersisted = null;
    });
    return recoveringPersisted;
  }

  async function findMutableLane(laneId) {
    const current = await snapshot();
    return flattenSnapshot(current).find((lane) => lane.id === laneId) ?? null;
  }

  return Object.freeze({
    async isIdle() {
      const current = await snapshot();
      return current.queued.length === 0 && current.active.length === 0;
    },
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
        const contract = validateStartContract(params, {
          expectedWorkspacePath: options.workspacePath
        });
        const owner = await ensureScheduler(contract.limits);
        owner.assertAvailable(contract.lanes.map((lane) => lane.id));
        const admissions = contract.lanes.map((lane) => owner.enqueue({
          ...lane,
          admissionSource: "fleet-supervisor",
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
      if (method === "message") {
        options.onActivity?.();
        const laneId = assertSafeId(params.laneId, "Message lane id");
        const owner = await ensureScheduler();
        const lane = await owner.message(laneId, assertMessage(params.message));
        monitorActive();
        return lane;
      }
      if (method === "session") {
        const laneId = assertSafeId(params.laneId, "Session lane id");
        const owner = await ensureScheduler();
        return owner.readSession(laneId);
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
      if (await this.isIdle()) {
        options.onIdle?.();
      } else {
        monitorActive();
      }
    },
    async close() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      await schedulerInitialization?.catch(() => undefined);
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
  const idleDelayMs = idleShutdownDelay(options.env ?? process.env);
  const shutdownGuard = createShutdownGuard();
  let idleTimer = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  function cancelIdleShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleShutdown(delayMs = idleDelayMs) {
    cancelIdleShutdown();
    const activityVersion = shutdownGuard.armIdleClose();
    idleTimer = setTimeout(() => void close({ idleActivityVersion: activityVersion }), delayMs);
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
      const releaseRequest = shutdownGuard.admit();
      try {
        if (method === "shutdown") {
          setTimeout(() => close(), 50).unref?.();
          return { accepted: true };
        }
        return await control.handle(method, params);
      } catch (error) {
        await control.restoreIdlePolicy().catch(() => undefined);
        throw error;
      } finally {
        releaseRequest();
      }
    }
  });

  const manifest = Object.freeze({
    schemaVersion: 1,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    workspaceKey,
    address: server.address,
    token,
    process: ownedProcess
  });

  async function close(closeOptions = {}) {
    if (closeOptions.idleActivityVersion !== undefined) {
      if (!await control.isIdle()) return stopped;
      if (!shutdownGuard.tryIdleClose(closeOptions.idleActivityVersion)) {
        if (!shutdownGuard.isClosing()) scheduleIdleShutdown();
        return stopped;
      }
    } else if (!shutdownGuard.forceClose()) {
      return stopped;
    }
    cancelIdleShutdown();
    await shutdownGuard.waitForDrained();
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

  try {
    await writeManifest(paths, manifest);
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  scheduleIdleShutdown(Math.max(2_000, idleDelayMs));
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await stopped;
}

if (isMainModule(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  await runSupervisor(options);
}
