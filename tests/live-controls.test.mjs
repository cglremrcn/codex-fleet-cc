import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureSupervisor,
  requestSupervisor,
  stopSupervisor
} from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { workspaceKey } from "../plugins/fleet/scripts/lib/paths.mjs";
import {
  buildEnv,
  installFakeCodex
} from "./upstream/fake-codex-fixture.mjs";
import { createShutdownGuard } from "../plugins/fleet/scripts/fleet-supervisor.mjs";

const SUPERVISOR = path.resolve("plugins", "fleet", "scripts", "fleet-supervisor.mjs");

async function fixture(t, behavior, envOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-live-controls-"));
  const workspacePath = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const binDir = path.join(root, "bin");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  installFakeCodex(binDir, behavior);
  const key = await workspaceKey(workspacePath);
  const options = {
    dataDir,
    workspaceKey: key,
    workspacePath,
    scriptPath: SUPERVISOR,
    nodeExecutable: process.execPath,
    env: { ...buildEnv(binDir), ...envOverrides }
  };
  const manifest = await ensureSupervisor(options);
  const manifests = [manifest];
  t.after(async () => {
    for (const owned of manifests.toReversed()) {
      await stopSupervisor({ ...options, manifest: owned }).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspacePath, dataDir, binDir, key, options, manifest, manifests };
}

function request(scope, method, params = {}) {
  return requestSupervisor({
    address: scope.manifest.address,
    workspaceKey: scope.key,
    token: scope.manifest.token,
    method,
    params
  });
}

function startContract(scope, id) {
  return {
    schemaVersion: 1,
    workspacePath: scope.workspacePath,
    lanes: [{
      id,
      role: "investigator",
      label: `Inspect ${id}`,
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: `Inspect the bounded fixture for ${id}.`,
      authority: {
        sandbox: "read-only",
        network: "off",
        process: { start: true, stopOwned: true }
      }
    }]
  };
}

async function waitForLane(scope, id, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await request(scope, "status");
    const lane = snapshot.lanes.find((candidate) => candidate.id === id);
    if (lane?.status === status) return lane;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${id} to reach ${status}.`);
}

async function waitForSupervisorExit(manifestPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(manifestPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the idle supervisor to exit.");
}

test("a second client follows up a completed supervisor-owned lane", async (t) => {
  const scope = await fixture(t, "slow-task");
  const admitted = await request(scope, "start", startContract(scope, "cross-process"));

  assert.equal(admitted.background, true);
  assert.equal(admitted.lanes[0].status, "running");
  const first = await waitForLane(scope, "cross-process", "complete");
  await stopSupervisor({ ...scope.options, manifest: scope.manifest });
  scope.manifest = await ensureSupervisor(scope.options);
  scope.manifests.push(scope.manifest);
  const continued = await request(scope, "followUp", {
    laneId: "cross-process",
    message: "Follow up on the second bounded fixture."
  });
  assert.equal(continued.status, "running");
  const second = await waitForLane(scope, "cross-process", "complete");

  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.turnId, first.turnId);
});

test("a fresh supervisor reconciles an interrupted read-only lane", async (t) => {
  const scope = await fixture(t, "interruptible-slow-task");
  await request(scope, "start", startContract(scope, "crash-recovery"));
  await waitForLane(scope, "crash-recovery", "running");

  await stopSupervisor({ ...scope.options, manifest: scope.manifest });
  scope.manifest = await ensureSupervisor(scope.options);
  scope.manifests.push(scope.manifest);

  const recovered = await request(scope, "result", { laneId: "crash-recovery" });
  assert.equal(recovered.status, "failed");
  assert.match(recovered.exitReason, /previous fleet supervisor ended/iu);
});

test("cancel requires an immutable preview and interrupts only its pinned turn", async (t) => {
  const scope = await fixture(t, "interruptible-slow-task");
  await request(scope, "start", startContract(scope, "cancel-owned"));
  const running = await waitForLane(scope, "cancel-owned", "running");
  const preview = await request(scope, "cancel", { laneId: "cancel-owned" });

  assert.equal(preview.writesPerformed, false);
  assert.equal(preview.expectedThreadId, running.threadId);
  assert.equal(preview.expectedTurnId, running.turnId);
  assert.match(preview.confirmationToken, /^[a-f0-9]{64}$/u);

  await assert.rejects(request(scope, "cancel", {
    laneId: "cancel-owned",
    expectedThreadId: running.threadId,
    expectedTurnId: "stale-turn",
    confirmationToken: preview.confirmationToken
  }), /confirmation|identity/i);

  const accepted = await request(scope, "cancel", {
    laneId: "cancel-owned",
    expectedThreadId: running.threadId,
    expectedTurnId: running.turnId,
    confirmationToken: preview.confirmationToken
  });
  assert.equal(accepted.accepted, true);
  const cancelled = await waitForLane(scope, "cancel-owned", "cancelled");
  assert.equal(cancelled.turnId, running.turnId);

  const fakeState = JSON.parse(
    await fs.readFile(path.join(scope.binDir, "fake-codex-state.json"), "utf8")
  );
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: running.threadId,
    turnId: running.turnId
  });
  await waitForSupervisorExit(scope.manifest.manifestPath);
});

test("invalid mutation after terminal work does not suppress idle shutdown", async (t) => {
  const scope = await fixture(t, "slow-task");
  await request(scope, "start", startContract(scope, "terminal-before-error"));
  await waitForLane(scope, "terminal-before-error", "complete");

  await assert.rejects(request(scope, "followUp", {
    laneId: "missing-terminal-lane",
    message: "This must fail without keeping the supervisor alive."
  }), /not a completed resumable lane/iu);

  await waitForSupervisorExit(scope.manifest.manifestPath);
});

test("default idle grace keeps one ephemeral broker alive for immediate follow-up", async (t) => {
  const scope = await fixture(t, "slow-task");
  const contract = startContract(scope, "ephemeral-follow-up");
  contract.lanes[0].ephemeral = true;
  await request(scope, "start", contract);
  const first = await waitForLane(scope, "ephemeral-follow-up", "complete");
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  const current = await ensureSupervisor(scope.options);
  assert.equal(current.process.pid, scope.manifest.process.pid);
  const continued = await request(scope, "followUp", {
    laneId: "ephemeral-follow-up",
    message: "Perform the bounded ephemeral follow-up."
  });
  assert.equal(continued.status, "running");
  const second = await waitForLane(scope, "ephemeral-follow-up", "complete");
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.turnId, first.turnId);
});

test("shutdown guard rejects close across an admitted boundary request", () => {
  const guard = createShutdownGuard();
  const idleVersion = guard.armIdleClose();
  const releaseRequest = guard.admit();

  assert.equal(guard.tryIdleClose(idleVersion), false);
  releaseRequest();
  assert.equal(guard.tryIdleClose(idleVersion), false);

  const nextIdleVersion = guard.armIdleClose();
  assert.equal(guard.tryIdleClose(nextIdleVersion), true);
  assert.throws(() => guard.admit(), /shutting down/iu);
});

test("a lane admitted near the idle boundary remains monitored", async (t) => {
  const scope = await fixture(t, "slow-task", { FLEET_SUPERVISOR_IDLE_MS: "750" });
  await request(scope, "start", startContract(scope, "idle-boundary-first"));
  await waitForLane(scope, "idle-boundary-first", "complete");
  await new Promise((resolve) => setTimeout(resolve, 650));

  await request(scope, "start", startContract(scope, "idle-boundary-second"));
  const second = await waitForLane(scope, "idle-boundary-second", "complete");

  assert.equal(second.status, "complete");
});
