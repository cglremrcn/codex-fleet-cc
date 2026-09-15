import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chooseFrontier, createFrontierPlans } from "../plugins/fleet/scripts/lib/frontier-planner.mjs";
import { createControlPlane } from "../plugins/fleet/scripts/fleet-supervisor.mjs";
import { makeTempDir } from "./helpers.mjs";
const KEY = "b".repeat(32);
const snapshot = { queued: [], active: [], history: [], limits: { maxActive: 2, maxWritersPerCheckout: 1, staggerMs: 0 } };
const node = (id, extra = {}) => ({ id, estimatedMs: 100, estimatedTokens: 100, ...extra });
const lane = (id, extra = {}) => ({ id, role: "investigator", label: id, model: "gpt-5.6-sol", effort: "high", prompt: "Read this bounded fixture.",
  authority: { sandbox: "read-only", network: "off", process: { start: true, stopOwned: true } }, ...extra });
const params = (workspace, graph = [node("a"), node("b")]) => ({
  contract: { schemaVersion: 1, workspacePath: workspace, limits: { maxActive: 2, staggerMs: 0 }, lanes: graph.map(n => lane(n.id)) }, graph,
  budget: { maxEstimatedTokens: 250, verificationReserveTokens: 50 }
});
const select = (graph, extra = {}) => chooseFrontier({ graph, lanes: graph.map(n => lane(n.id)), snapshot,
  budget: { maxEstimatedTokens: 1000, verificationReserveTokens: 100 }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await fs.realpath(makeTempDir("fleet-frontier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com"); git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(workspace, "code.txt"), "version A"); git("add", "."); git("commit", "-m", "initial");
  let calls = 0, initialized = 0; const records = new Map();
  const runtime = { async startLane(contract) { calls++; const result = { ...contract, threadId: `thread-${contract.id}`, turnId: `turn-${contract.id}`,
    status: "complete", outcome: "accomplished", workPerformed: ["inspected"], verificationResults: [{ check: "unit", status: "passed" }] }; records.set(contract.id, result); return result; },
    inspectLane: id => records.get(id), async close() {}, async continueLane() { throw new Error("unexpected"); },
    async resumeLane() { throw new Error("unexpected"); }, async interruptLane() {} };
  const options = { dataDir: path.join(root, "private"), workspacePath: workspace, workspaceKey: KEY, token: "c".repeat(64),
    createRuntime: async () => { initialized++; return runtime; } };
  let control = createControlPlane(options); t.after(() => control.close());
  const request = (operation, parameters) => control.handle("control", { schemaVersion: 1, requestId: "fixture", operation, workspacePath: workspace, params: parameters });
  return { workspace, request, runtime, control, calls: () => calls, initialized: () => initialized,
    async restart() { await control.close(); control = createControlPlane(options); } };
}

test("critical path admits ready dependency roots, not their blocked descendants", () => {
  const result = select([node("short"), node("root"), node("child", { estimatedMs: 900, dependsOn: [{ laneId: "root" }] })], { snapshot: { ...snapshot, limits: { maxActive: 1 } }, limits: { maxActive: 1 } });
  assert.deepEqual(result.selected.map(n => n.id), ["root"]);
  assert.ok(result.deferred.some(n => n.id === "child" && n.reason === "dependency-evidence"));
  assert.equal(result.billingOrQuota, false);
});

test("cyclic, mismatched, duplicate and self-dependent graphs fail before selection", () => {
  assert.throws(() => select([node("a", { dependsOn: [{ laneId: "b" }] }), node("b", { dependsOn: [{ laneId: "a" }] })]), { code: "PLAN_GRAPH_CYCLE" });
  assert.throws(() => select([node("a"), node("a")]), { code: "PLAN_GRAPH_INVALID" });
  assert.throws(() => select([node("a", { dependsOn: [{ laneId: "a" }] })]), { code: "PLAN_GRAPH_INVALID" });
  assert.throws(() => select([node("a")], { lanes: [lane("b")] }), { code: "PLAN_GRAPH_INVALID" });
});

test("estimated budget preserves verification reserve and capacity accounts for queued/reserved work", () => {
  const result = select([node("a"), node("b")], { budget: { maxEstimatedTokens: 150, verificationReserveTokens: 51 } });
  assert.equal(result.selected.length, 0); assert.equal(result.remainingEstimatedTokens, 99);
  assert.throws(() => select([node("a")], { budget: { maxEstimatedTokens: 1, verificationReserveTokens: 2 } }), { code: "PLAN_BUDGET_INVALID" });
  assert.equal(select([node("a")], { snapshot: { ...snapshot, active: [lane("live")], continuationReservations: [{ laneId: "resumed" }] } }).selected.length, 0);
});

test("age tiers prioritize waiting tasks; FIFO is retained as a comparison baseline", () => {
  const graph = [node("long", { estimatedMs: 5000 }), node("old", { waitSince: 0 })];
  assert.equal(select(graph, { now: 120000 }).selected[0].id, "old");
  assert.equal(select(graph, { now: 120000, strategy: "fifo" }).selected[0].id, "long");
});

test("dependency completion requires a current matching receipt, not a completed label", () => {
  const graph = [node("a", { dependsOn: [{ laneId: "prior", receiptId: "f".repeat(64) }] })];
  assert.equal(select(graph, { snapshot: { ...snapshot, history: [{ id: "prior", status: "verified" }] } }).selected.length, 0);
  assert.equal(select(graph, { validDependencies: new Set([`prior:${"f".repeat(64)}`]) }).selected.length, 1);
});

test("mutable frontier is one task and never mixed with read-only peers", () => {
  const graph = [node("writer", { estimatedMs: 500 }), node("reader")];
  const result = select(graph, { lanes: [lane("writer", { authority: { sandbox: "workspace-write" } }), lane("reader")] });
  assert.deepEqual(result.selected.map(n => n.id), ["writer"]);
  assert.equal(result.deferred[0].reason, "source-isolation");
});

test("actual supervisor prepares without Codex and applies one wave once under concurrent requests", async t => {
  const f = await fixture(t); const plan = await f.request("prepare", params(f.workspace));
  assert.equal(plan.ok, true, JSON.stringify(plan)); assert.equal(plan.data.selected.length, 2);
  assert.equal(f.initialized(), 0); assert.equal(await f.control.isIdle(), false, "prepared plan holds bounded local lifetime");
  const applications = await Promise.all(Array.from({ length: 6 }, () => f.request("apply", { planToken: plan.data.planToken })));
  for (const result of applications) assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls(), 2); assert.deepEqual(applications[0], applications[5]);
  assert.equal((await f.request("apply", { planToken: plan.data.planToken })).ok, true); assert.equal(f.calls(), 2);
});

test("source change or supervisor restart cannot reuse a prepared dispatch", async t => {
  const f = await fixture(t); const plan = await f.request("prepare", params(f.workspace));
  await fs.writeFile(path.join(f.workspace, "code.txt"), "revision B");
  const result = await f.request("apply", { planToken: plan.data.planToken });
  assert.equal(result.ok, false); assert.equal(result.error.code, "PLAN_STALE"); assert.equal(f.calls(), 0);
  await f.restart(); const lost = await f.request("apply", { planToken: plan.data.planToken });
  assert.equal(lost.error.code, "PLAN_UNAVAILABLE"); assert.equal(f.calls(), 0);
});

test("changed Fleet admission invalidates a plan instead of silently skipping candidate IDs", async t => {
  const f = await fixture(t); const plan = await f.request("prepare", params(f.workspace));
  await f.control.handle("start", { ...params(f.workspace).contract, lanes: [lane("other")] });
  const stale = await f.request("apply", { planToken: plan.data.planToken });
  assert.equal(stale.error.code, "PLAN_STALE"); assert.equal(f.calls(), 1);
});

test("unconfirmed writer plans fail admission validation without initializing Codex", async t => {
  const f = await fixture(t); const input = params(f.workspace); input.contract.lanes[0].authority.sandbox = "workspace-write";
  const result = await f.request("prepare", input); assert.equal(result.ok, false); assert.equal(f.initialized(), 0);
});

test("expired plans and post-boundary failure never start the same intent twice", async () => {
  let now = 1000, calls = 0;
  const current = { snapshot, source: { digest: "a".repeat(64) } };
  const plans = createFrontierPlans({ workspacePath: "/workspace", snapshot: () => snapshot, now: () => now,
    evidence: { currentContext: async () => current, verifyReceipt: async () => ({ current: true }) },
    transaction: operation => operation(), admit: async (_, recheck) => { await recheck(); calls++; return { completion: Promise.reject(new Error("lost acknowledgement")) }; } });
  try {
    const input = params("/workspace"); const first = await plans.prepare(input);
    now += 120001; assert.throws(() => plans.apply({ planToken: first.planToken }), { code: "PLAN_UNAVAILABLE" });
    const prepared = await plans.prepare(input);
    await assert.rejects(plans.apply({ planToken: prepared.planToken }), { code: "PLAN_ADMISSION_UNCERTAIN" });
    await assert.rejects(plans.apply({ planToken: prepared.planToken }), { code: "PLAN_ADMISSION_UNCERTAIN" });
    assert.equal(calls, 1);
  } finally { plans.dispose(); }
});

function serializedPlanFixture(t, readContext) {
  let queue = Promise.resolve();
  const plans = createFrontierPlans({
    workspacePath: "/workspace", now: () => 1000, snapshot: async () => snapshot,
    evidence: { currentContext: readContext, verifyReceipt: async () => ({ current: true }) },
    transaction(operation) {
      const current = queue.then(operation);
      queue = current.catch(() => undefined);
      return current;
    },
    admit: async () => assert.fail("Preparation must not dispatch work")
  });
  t.after(() => plans.dispose());
  return plans;
}

test("concurrent preparations cannot exceed the retained plan count after waiting for a transaction", async t => {
  const gate = deferred();
  const plans = serializedPlanFixture(t, async () => {
    await gate.promise;
    return { snapshot, source: { digest: "a".repeat(64) } };
  });
  const outcomes = Promise.allSettled(Array.from({ length: 24 }, () => plans.prepare(params("/workspace"))));
  gate.resolve();
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 8);
  assert.equal(results.filter(result => result.status === "rejected").length, 16);
  for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "PLAN_LIMIT");
  assert.equal(plans.stats().retained, 8);
  assert.ok(plans.stats().retainedBytes <= 512 * 1024);
});

test("disposal rejects preparations waiting for their transaction without starting source reads", async t => {
  let reads = 0;
  const plans = serializedPlanFixture(t, async () => {
    reads++;
    return { snapshot, source: { digest: "a".repeat(64) } };
  });
  const pending = plans.prepare(params("/workspace"));
  plans.dispose();
  await assert.rejects(pending, { code: "CONTROL_CLOSED" });
  assert.equal(reads, 0);
  assert.equal(plans.stats().retained, 0);
});

test("a preparation already reading source cannot publish a token after disposal", async t => {
  const gate = deferred(), entered = deferred();
  const plans = serializedPlanFixture(t, async () => {
    entered.resolve();
    await gate.promise;
    return { snapshot, source: { digest: "a".repeat(64) } };
  });
  const pending = plans.prepare(params("/workspace"));
  await entered.promise;
  plans.dispose();
  gate.resolve();
  await assert.rejects(pending, { code: "CONTROL_CLOSED" });
  assert.equal(plans.stats().retained, 0);
});
