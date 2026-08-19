import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createConsoleController } from "../plugins/fleet/scripts/lib/console-controller.mjs";
import { createLane, transitionLane } from "../plugins/fleet/scripts/lib/domain.mjs";
import { createRuntime } from "../plugins/fleet/scripts/lib/runtime-adapter.mjs";
import { writeWorkspaceState } from "../plugins/fleet/scripts/lib/safe-state.mjs";
import { createScheduler } from "../plugins/fleet/scripts/lib/scheduler.mjs";
import { startFakeCodex } from "./fixtures/fake-codex-app-server.mjs";
import { makeTempDir } from "./helpers.mjs";

const WORKSPACE_KEY = "0123456789abcdef0123456789abcdef";

function authority() {
  return {
    sandbox: "read-only",
    network: "off",
    process: { start: true, stopOwned: true }
  };
}

function contract(id, role, label, workspacePath) {
  return {
    id,
    role,
    label,
    workspacePath,
    workspaceKey: WORKSPACE_KEY,
    checkoutKey: WORKSPACE_KEY,
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: `Objective: ${label}.\nExclusions: no external effects.`,
    authority: authority(),
    priority: "normal"
  };
}

async function waitForHistory(scheduler, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await scheduler.reconcile();
    if (snapshot.history.length >= expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fleet history did not reach ${expected} lanes.`);
}

async function waitForRuntime(runtime, id, status, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.inspectLane(id)?.status === status) return runtime.inspectLane(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Lane ${id} did not reach ${status}.`);
}

test("fleet shares one broker, follows up, verifies, renders, and preserves the draft", async (t) => {
  let runtime;
  t.after(() => runtime?.close());
  const fake = startFakeCodex(t);
  const stateRoot = makeTempDir("codex-fleet-e2e-state-");
  const draftPath = path.join(stateRoot, "claude-draft.txt");
  const draft = "keep this exact Claude draft";
  await fs.writeFile(draftPath, draft, "utf8");
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));

  const events = [];
  runtime = await createRuntime({
    codexCommand: fake.command,
    cwd: fake.workspace,
    env: fake.env,
    onEvent: (event) => events.push(event)
  });
  let pendingWrite = Promise.resolve();
  const store = {
    write(snapshot) {
      pendingWrite = pendingWrite.then(() => writeWorkspaceState(stateRoot, {
        schemaVersion: 1,
        updatedAt: "2026-08-17T12:00:00.000Z",
        lanes: [...snapshot.queued, ...snapshot.active, ...snapshot.history]
      }));
      return pendingWrite;
    }
  };
  const scheduler = createScheduler({
    runtime,
    store,
    limits: { maxActive: 3, maxWritersPerCheckout: 1, staggerMs: 0 }
  });

  await Promise.all([
    scheduler.enqueue(contract("inspect", "investigator", "Inspect runtime", fake.workspace)),
    scheduler.enqueue(contract("build", "implementer", "Build console", fake.workspace))
  ]);
  let snapshot = await waitForHistory(scheduler, 2);
  assert.equal(fake.appServerStarts(), 1);
  assert.deepEqual(snapshot.history.map((lane) => lane.status), ["complete", "complete"]);

  await runtime.continueLane("inspect", "Bounded follow up: report the evidence reference.");
  const followedUp = await waitForRuntime(runtime, "inspect", "complete");
  assert.match(followedUp.lastMessage, /Follow-up prompt accepted/u);

  await scheduler.enqueue(contract(
    "verify",
    "independent-verifier",
    "Verify result",
    fake.workspace
  ));
  snapshot = await waitForHistory(scheduler, 3);
  const verifier = snapshot.history.find((lane) => lane.id === "verify");
  assert.equal(verifier.status, "complete");

  let verified = createLane({
    id: "inspect",
    role: "investigator",
    label: "Inspect runtime",
    workspaceKey: WORKSPACE_KEY,
    model: "gpt-5.6-sol",
    effort: "high",
    authority: authority()
  });
  verified = transitionLane(verified, "running", { at: "2026-08-17T12:00:00.000Z" });
  verified = transitionLane(verified, "complete", {
    at: "2026-08-17T12:00:01.000Z",
    resultRef: "fleet://results/inspect"
  });
  verified = transitionLane(verified, "verified", {
    at: "2026-08-17T12:00:02.000Z",
    verifierLaneId: "verify",
    evidenceRefs: ["fleet://evidence/verify"]
  });

  const consoleSnapshot = {
    schemaVersion: 1,
    workspace: { name: "fleet-e2e", branch: "main" },
    runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
    lanes: [
      { ...snapshot.history.find((lane) => lane.id === "build"), authority: authority() },
      { ...verified, authority: authority(), phase: "verified" },
      { ...verifier, authority: authority(), phase: "complete" }
    ]
  };
  const screens = [];
  const controller = createConsoleController({
    snapshot: consoleSnapshot,
    terminal: { columns: 140, rows: 34 },
    draftPath,
    preferences: { color: false, motion: false },
    write: (value) => screens.push(value),
    spawnEditor: async (receivedDraft) => {
      assert.equal(receivedDraft, draftPath);
      assert.equal(await fs.readFile(receivedDraft, "utf8"), draft);
    }
  });
  await controller.render();
  await controller.dispatch({ type: "move", delta: 1 });
  await controller.dispatch({ type: "activate" });
  await controller.dispatch({ type: "edit" });
  const returned = await controller.dispatch({ type: "quit" });

  assert.equal(returned.exit, true);
  assert.equal(await fs.readFile(draftPath, "utf8"), draft);
  assert.match(screens.join("\n"), /VERIFIED/u);
  assert.ok(events.some((event) => event.type === "lane.continued"));
  assert.equal(fake.appServerStarts(), 1);
});
