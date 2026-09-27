import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createScheduler, recoverPersistedRecords } from "../plugins/fleet/scripts/lib/scheduler.mjs";
import { validateStartContract } from "../plugins/fleet/scripts/lib/start-contract.mjs";
import { executionBinding } from "../plugins/fleet/scripts/lib/execution-evidence.mjs";
import { sanitizeLaneForPersistence } from "../plugins/fleet/scripts/lib/redaction.mjs";
const key = "a".repeat(32), workspacePath = path.resolve(".");
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const contract = (id, sandbox = "read-only", extra = {}) => ({ id, role: "implementer", label: id, model: "gpt-5.6-sol", effort: "high",
  workspaceKey: key, workspacePath, prompt: "Private fixture objective.", authority: { sandbox, network: "off", process: { start: true, stopOwned: true } }, ...extra });
function fixture(extra = {}) {
  const records = new Map(), calls = []; let sequence = 0;
  const runtime = { async startLane(input) { calls.push(input.id); const value = { ...input, status: "running", threadId: input.id, turnId: `turn-${++sequence}`,
    outcome: "accomplished", workPerformed: ["Done"], verificationResults: [{ check: "unit", status: "passed" }] }; records.set(input.id, value); return value; },
    inspectLane: id => records.get(id) ?? null,
    async continueLane(id) { const value = { ...records.get(id), status: "running", turnId: `turn-${++sequence}` }; records.set(id, value); return value; },
    async steerLane(id) { return records.get(id); }, async resumeLane() {}, async interruptLane() {} };
  const scheduler = createScheduler({ runtime, workspacePath, store: { write: async () => {} }, limits: { maxActive: 3, staggerMs: 0 }, ...extra });
  const complete = async id => { records.get(id).status = "complete"; await scheduler.reconcile(); };
  return { scheduler, runtime, records, calls, complete };
}

test("checkpoint verifier reserves the physical source before its async validation", async () => {
  const guard = defer();
  const f = fixture({ beforeDispatch: input => input.verificationCheckpoint ? guard.promise : undefined });
  const verifying = f.scheduler.enqueue(contract("verify", "read-only", { role: "independent-verifier", verificationCheckpoint: "f".repeat(64) }));
  await tick(); const writing = f.scheduler.enqueue(contract("write", "workspace-write")); await tick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.scheduler.snapshot().queued[0].queueBlocker.kind, "verification-source-barrier");
  guard.resolve(); await verifying; assert.deepEqual(f.calls, ["verify"]);
  await f.complete("verify"); await writing; assert.deepEqual(f.calls, ["verify", "write"]);
});

test("existing writers keep a checkpoint verifier from starting until source is quiet", async () => {
  let validated = 0; const f = fixture({ beforeDispatch: input => { if (input.verificationCheckpoint) validated++; } });
  await f.scheduler.enqueue(contract("write", "workspace-write"));
  const verifying = f.scheduler.enqueue(contract("verify", "read-only", { role: "independent-verifier", verificationCheckpoint: "f".repeat(64) }));
  await tick(); assert.equal(validated, 0);
  assert.equal(f.scheduler.snapshot().queued[0].queueBlocker.kind, "verification-source-barrier");
  await f.complete("write"); await verifying; assert.equal(validated, 1);
});

test("source transaction pauses starts, continuation and steering and releases cleanly after errors", async () => {
  const f = fixture(); await f.scheduler.enqueue(contract("live"));
  const pause = defer(); let queued;
  const transaction = f.scheduler.withAdmissionPause(async () => {
    queued = f.scheduler.enqueue(contract("later", "workspace-write"));
    await assert.rejects(f.scheduler.message("live", "steer"), { code: "SOURCE_BUSY" });
    await assert.rejects(f.scheduler.continue("live", "continue"), { code: "SOURCE_BUSY" });
    await pause.promise; throw new Error("fixture capture failed");
  });
  const rejected = assert.rejects(transaction, /capture failed/);
  await tick(); assert.deepEqual(f.calls, ["live"]);
  pause.resolve(); await rejected; await queued; assert.deepEqual(f.calls, ["live", "later"]);
});

test("bound verifiers cannot be steered, continued, or started without a guard", async () => {
  const input = contract("verify", "read-only", { role: "independent-verifier", verificationCheckpoint: "f".repeat(64) });
  const missing = fixture(); await assert.rejects(missing.scheduler.enqueue(input), { code: "VERIFIER_GUARD_UNAVAILABLE" });
  assert.deepEqual(missing.calls, []);
  const f = fixture({ beforeDispatch: () => {} }); await f.scheduler.enqueue(input);
  await assert.rejects(f.scheduler.message("verify", "change checks"), { code: "VERIFIER_REQUIRES_FRESH_LANE" });
  await f.complete("verify"); await assert.rejects(f.scheduler.continue("verify", "continue"), { code: "VERIFIER_REQUIRES_FRESH_LANE" });
});

test("two continuation requests pinned to one terminal revision cannot both execute", async () => {
  const f = fixture(); await f.scheduler.enqueue(contract("worker")); await f.complete("worker");
  const before = f.scheduler.snapshot().history[0];
  const expected = { expectedThreadId: before.threadId, expectedTurnId: before.turnId, expectedExecutionRevision: before.executionRevision };
  const outcomes = await Promise.allSettled([f.scheduler.continue("worker", "next", expected), f.scheduler.continue("worker", "duplicate", expected)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(result => result.status === "rejected").reason.code, "CONTROL_TARGET_CHANGED");
});

test("instruction chain and result binding remain stable after redacted persistence and restart", async () => {
  const f = fixture(); await f.scheduler.enqueue(contract("worker"));
  const first = f.scheduler.snapshot().active[0].instructionDigest;
  await f.scheduler.message("worker", "Secret new task instructions that must not persist.");
  await f.complete("worker"); const current = f.scheduler.snapshot().history[0];
  assert.notEqual(current.instructionDigest, first); assert.equal(current.executionRevision, 1);
  const safe = sanitizeLaneForPersistence(current), restored = recoverPersistedRecords([safe])[0];
  assert.deepEqual(executionBinding(current), executionBinding(restored));
  assert.doesNotMatch(JSON.stringify(safe), /Secret new task|Private fixture objective/);
  const mutated = { ...restored, verificationResults: [{ check: "unit", status: "failed" }] };
  assert.notDeepEqual(executionBinding(mutated), executionBinding(current));
});

test("bound verifier schemas reject empty bindings and mixed writer/verifier batches", () => {
  const verifier = contract("verify", "read-only", { role: "independent-verifier", verificationCheckpoint: "f".repeat(64) });
  const bare = value => { const { workspaceKey: _key, workspacePath: _path, ...lane } = value; return lane; };
  assert.throws(() => validateStartContract({ schemaVersion: 1, workspacePath, lanes: [bare({ ...verifier, verificationCheckpoint: "" })] }));
  assert.throws(() => validateStartContract({ schemaVersion: 1, workspacePath, confirmationRef: "fixture-user-authorized", lanes: [bare(verifier), bare(contract("writer", "workspace-write"))] }), /mix checkpoint/);
  assert.throws(() => createScheduler({ runtime: fixture().runtime, store: { write: () => {} }, limits: { maxWritersPerCheckout: 2 } }), /must be 1/);
});

test("shutdown releases read-only waits without inferring task completion", async () => {
  const f = fixture(); await f.scheduler.enqueue(contract("live"));
  const waiting = f.scheduler.waitForLane("live", { timeoutMs: 3600000 });
  const checked = assert.rejects(waiting, { code: "CONTROL_CLOSED" });
  await tick(); f.scheduler.closeObservationWaits(); await checked;
  assert.equal(f.scheduler.snapshot().active[0].status, "running");
});
