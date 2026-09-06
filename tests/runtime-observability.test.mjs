import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FleetRuntime } from "../plugins/fleet/scripts/lib/runtime-adapter.mjs";
import { discoverModels } from "../plugins/fleet/scripts/lib/model-catalog.mjs";
import { normalizeTokenUsage, usageFromNotification } from "../plugins/fleet/scripts/lib/token-usage.mjs";
import { validateStartContract } from "../plugins/fleet/scripts/lib/start-contract.mjs";
import { createControlPlane } from "../plugins/fleet/scripts/fleet-supervisor.mjs";
import { createScheduler, recoverPersistedRecords } from "../plugins/fleet/scripts/lib/scheduler.mjs";
import { writeWorkspaceState, readWorkspaceState } from "../plugins/fleet/scripts/lib/safe-state.mjs";
import { runCli } from "../plugins/fleet/scripts/lib/cli.mjs";

const workspaceKey = "a".repeat(32);
function contract(overrides = {}) {
  return { id: "lane-a", role: "investigator", label: "Inspect", groupPath: "backend/auth",
    model: "gpt-5.6-sol", effort: "high", workspaceKey, workspacePath: path.resolve("."),
    prompt: "Inspect the bounded fixture", authority: { sandbox: "read-only", process: { start: true } }, ...overrides };
}
function rootContract(model = "future-test-model", effort = "deep") {
  const { workspaceKey: unusedKey, workspacePath: unusedPath, ...lane } = contract({ model, effort });
  return { schemaVersion: 1, workspacePath: path.resolve("."), modelPolicy: "runtime", lanes: [lane] };
}
function modelEntry(model = "future-test-model") {
  return { model, supportedReasoningEfforts: [{ reasoningEffort: "deep" }], hidden: false };
}
function broker() {
  const calls = []; let turn = 0;
  return { calls, protocolVersion: 1, setEventHandler() {}, async close() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === "model/list") return { data: [modelEntry()], nextCursor: null };
    if (method === "thread/start") return { thread: { id: "thread-a" } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
    return {};
  } };
}
function usage(total = 120) {
  return { total: { inputTokens: total - 20, outputTokens: 20, totalTokens: total, cachedInputTokens: 40,
    reasoningOutputTokens: 10, cacheWriteInputTokens: 0 } };
}

test("runtime usage snapshots replace cumulative totals and never retarget an active turn", async () => {
  const b = broker(); const runtime = new FleetRuntime(b);
  await runtime.startLane(contract());
  const notify = (value, turnId = "turn-1") => runtime.handleNotification({ method: "thread/tokenUsage/updated",
    params: { threadId: "thread-a", turnId, tokenUsage: value } });
  notify(usage()); notify(usage());
  assert.equal(runtime.inspectLane("lane-a").tokenUsage.total, 120);
  notify(usage(150), "historical-turn");
  assert.equal(runtime.inspectLane("lane-a").turnId, "turn-1");
  assert.equal(runtime.inspectLane("lane-a").tokenUsage.total, 150);
  notify(usage(120));
  assert.equal(runtime.inspectLane("lane-a").tokenUsage.total, 150);
  assert.equal(runtime.inspectLane("lane-a").tokenUsage.cachedInput, 40);
  assert.ok(b.calls.every(call => !Object.hasOwn(call.params, "tokenUsage")));
});

test("absent, unsafe and partial usage is unknown, never invented zero", () => {
  assert.equal(normalizeTokenUsage(null), null);
  assert.equal(normalizeTokenUsage({ input: -1, total: Infinity, output: 0.1 }), null);
  assert.equal(usageFromNotification({ total: { inputTokens: 123 } }), null);
  assert.deepEqual(normalizeTokenUsage({ total: 0 }), { total: 0 });
  assert.equal(usageFromNotification({ total: { inputTokens: 1, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER + 1 } }), null);
});

test("reported usage survives runtime resume and is not sent back as a turn parameter", async () => {
  const b = broker(); const runtime = new FleetRuntime(b);
  await runtime.resumeLane({ ...contract(), status: "complete", threadId: "thread-a", turnId: "previous",
    tokenUsage: { input: 100, output: 20, total: 120 } }, path.resolve("."), "Continue bounded review");
  assert.equal(runtime.inspectLane("lane-a").tokenUsage.total, 120);
  assert.ok(b.calls.every(call => !Object.hasOwn(call.params, "tokenUsage")));
});

test("scheduler and disk preserve folder and late terminal usage through recovery", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-usage-test-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  let record;
  const runtime = { async startLane(lane) { record = { ...lane, status: "running", threadId: "t", turnId: "u" }; return record; },
    inspectLane() { return record; }, async interruptLane() {}, async continueLane() {}, async resumeLane() {}, listLanes() { return [record]; } };
  const scheduler = createScheduler({ runtime, store: { async write() {} }, limits: { staggerMs: 0 } });
  await scheduler.enqueue(contract());
  record.status = "complete"; await scheduler.reconcile();
  record.tokenUsage = { input: 100, output: 20, total: 120 }; await scheduler.reconcile();
  const history = scheduler.snapshot().history;
  assert.equal(history[0].groupPath, "backend/auth");
  assert.equal(history[0].tokenUsage.total, 120);
  await writeWorkspaceState(directory, { schemaVersion: 1, updatedAt: new Date().toISOString(), lanes: history });
  const persisted = (await readWorkspaceState(directory)).lanes;
  const restored = recoverPersistedRecords(persisted);
  assert.equal(restored[0].tokenUsage.total, 120);
  assert.equal(restored[0].groupPath, "backend/auth");
});

test("model discovery paginates the live catalogue without starting model turns", async () => {
  const calls = [];
  const models = await discoverModels(async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [modelEntry("second")], nextCursor: null }
      : { data: [modelEntry()], nextCursor: "next" };
  });
  assert.equal(models.length, 2);
  assert.ok(calls.every(c => c.method === "model/list" && c.params.includeHidden === false));
  assert.equal(calls[1].params.cursor, "next");
});

test("model discovery rejects non-advancing pagination and malformed capabilities", async () => {
  await assert.rejects(discoverModels(async () => ({ data: [modelEntry()], nextCursor: "repeat" })), /advance/);
  await assert.rejects(discoverModels(async () => ({ data: [{}] })), /malformed/);
  await assert.rejects(discoverModels(async () => ({ data: [modelEntry()], nextCursor: 3 })), /pagination/);
  await assert.rejects(discoverModels(async () => { throw new Error("unavailable"); }), /unavailable/);
});

test("runtime coalesces concurrent model discovery and caches reported capabilities", async () => {
  const b = broker(); const runtime = new FleetRuntime(b);
  await Promise.all([runtime.listModels(), runtime.listModels(), runtime.listModels()]);
  await runtime.listModels();
  assert.equal(b.calls.filter(c => c.method === "model/list").length, 1);
  assert.ok(b.calls.every(c => c.method !== "turn/start"));
});

test("runtime-policy contracts are fail-closed without a trusted catalogue", () => {
  const raw = rootContract();
  assert.throws(() => validateStartContract(raw), /not reported/);
  assert.equal(validateStartContract(raw, { deferModelValidation: true }).modelPolicy, "runtime");
  const options = { modelCatalog: [{ model: "future-test-model", efforts: ["deep"] }] };
  assert.equal(validateStartContract(raw, options).lanes[0].model, "future-test-model");
  assert.throws(() => validateStartContract(rootContract("future-test-model", "unsupported"), options), /not supported/);
  assert.throws(() => validateStartContract({ ...raw, modelCatalog: options.modelCatalog }, options), /Unknown/);
  const legacy = { ...rootContract("gpt-5.6-sol", "high") }; delete legacy.modelPolicy;
  assert.equal(validateStartContract(legacy).lanes[0].model, "gpt-5.6-sol");
});

test("supervisor refuses unavailable runtime models before any lane is admitted", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-model-test-"));
  const b = broker(); const runtime = new FleetRuntime(b);
  const control = createControlPlane({ dataDir: root, workspaceKey, workspacePath: path.resolve("."), createRuntime: async () => runtime });
  t.after(async () => { await control.close(); await fs.rm(root, { force: true, recursive: true }); });
  await assert.rejects(control.handle("start", rootContract("unavailable-model")), /not reported/);
  assert.equal(runtime.listLanes(workspaceKey).length, 0);
  assert.ok(b.calls.every(c => c.method === "model/list"));
  const result = await control.handle("models", {});
  assert.equal(result.source, "connected-codex-runtime");
});

test("models CLI returns the exact supervisor catalogue, never a guessed model alias", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-model-cli-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  let output = ""; const calls = [];
  const code = await runCli(["models", "--json", "--workspace", root], {
    cwd: root, env: { HOME: root, LOCALAPPDATA: root }, stdout: s => { output += s; },
    stderr: s => { throw new Error(s); },
    home: root,
    dependencies: { ensureSupervisor: async () => ({ address: "local", token: "private" }),
    requestSupervisor: async request => { calls.push(request.method); return { models: [{ model: "reported", efforts: ["high"] }] }; } } });
  assert.equal(code, 0); assert.deepEqual(calls, ["models"]);
  assert.equal(JSON.parse(output).models[0].model, "reported");
});

test("late notifications from an old turn cannot retarget an already active turn", async () => {
  const b = broker(); const runtime = new FleetRuntime(b);
  await runtime.startLane(contract());
  const lane = runtime.lanes.get("lane-a");
  // Use the real continuation path after a terminal result, then inject delayed upstream events.
  lane.status = "complete";
  await runtime.continueLane("lane-a", "Continue the bounded investigation");
  assert.equal(runtime.inspectLane("lane-a").turnId, "turn-2");
  runtime.handleNotification({ method: "item/started", params: { threadId: "thread-a", turnId: "turn-1", item: { type: "commandExecution", command: "old" } } });
  assert.equal(runtime.inspectLane("lane-a").turnId, "turn-2");
});

test("supervisor-rooted scheduler serializes writers even with different logical checkout labels", async () => {
  const records = new Map();
  const runtime = { async startLane(lane) { const state = { ...lane, status: "running", threadId: lane.id, turnId: lane.id }; records.set(lane.id, state); return state; },
    inspectLane: id => records.get(id), async continueLane() {}, async resumeLane() {}, async interruptLane() {} };
  const scheduler = createScheduler({ runtime, workspacePath: path.resolve("."), store: { async write() {} }, limits: { maxActive: 3, staggerMs: 0 } });
  const first = scheduler.enqueue(contract({ id: "writer-a", checkoutKey: "label-a", authority: { sandbox: "workspace-write", process: { start: true } } }));
  const second = scheduler.enqueue(contract({ id: "writer-b", checkoutKey: "label-b", authority: { sandbox: "workspace-write", process: { start: true } } }));
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.snapshot().active.length, 1);
  assert.equal(scheduler.snapshot().queued.length, 1);
  records.get("writer-a").status = "complete";
  await scheduler.reconcile(); await second;
  assert.equal(scheduler.snapshot().active[0].id, "writer-b");
});

test("unchanged reconciliation does not repeatedly write the same durable state", async () => {
  let writes = 0; const record = { ...contract(), status: "running", threadId: "t", turnId: "u" };
  const runtime = { async startLane() { return record; }, inspectLane() { return record; },
    async continueLane() {}, async resumeLane() {}, async interruptLane() {} };
  const scheduler = createScheduler({ runtime, store: { async write() { writes += 1; } }, limits: { staggerMs: 0 } });
  await scheduler.enqueue(contract()); await scheduler.reconcile();
  const before = writes;
  for (let i = 0; i < 100; i++) await scheduler.reconcile();
  assert.equal(writes, before);
  record.tokenUsage = { input: 100, output: 20, total: 120 };
  await scheduler.reconcile(); assert.equal(writes, before + 1);
});

test("a rejected durable write is retried even when its snapshot is unchanged", async () => {
  let writes = 0;
  const runtime = { async startLane() {}, inspectLane() {}, async continueLane() {}, async resumeLane() {}, async interruptLane() {} };
  const scheduler = createScheduler({ runtime, store: { async write() { if (++writes === 1) throw new Error("disk unavailable"); } } });
  await assert.rejects(scheduler.persist(), /disk unavailable/);
  await scheduler.persist(); assert.equal(writes, 2);
  await scheduler.persist(); assert.equal(writes, 2);
});

test("retired turn events during continuation dispatch cannot revive the previous turn", async () => {
  const b = broker(); const baseRequest = b.request.bind(b); let runtime; let turns = 0;
  b.request = async (method, params) => {
    if (method === "turn/start" && ++turns === 2) {
      runtime.handleNotification({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "turn-1" } } });
      assert.equal(runtime.inspectLane("lane-a").turnId, null);
    }
    return baseRequest(method, params);
  };
  runtime = new FleetRuntime(b); await runtime.startLane(contract());
  runtime.lanes.get("lane-a").status = "complete";
  await runtime.continueLane("lane-a", "Continue bounded work");
  assert.equal(runtime.inspectLane("lane-a").turnId, "turn-2");
});

test("a failed serialized state write does not poison all later state writes", async () => {
  const { serializeStateStore } = await import("../plugins/fleet/scripts/fleet-supervisor.mjs");
  let count = 0;
  const store = serializeStateStore("unused", async () => { if (++count === 1) throw new Error("transient disk failure"); });
  const empty = { queued: [], active: [], history: [] };
  await assert.rejects(store.write(empty), /transient disk failure/);
  await store.write(empty); assert.equal(count, 2);
});

test("compact status retains action signals and identity without copying transcripts", async () => {
  const { summarizeStatusLane } = await import("../plugins/fleet/scripts/lib/plain-status.mjs");
  const detailed = { ...contract(), status: "outcome_unknown", admissionId: "admission-1", threadId: "thread-1", turnId: "turn-1",
    lastMessage: "long transcript ".repeat(1000), workPerformed: ["work"], evidenceRefs: ["proof"], artifactRefs: ["a"],
    controllerRequest: { kind: "runtime_blocker", question: "x".repeat(1000) } };
  const summary = summarizeStatusLane(detailed);
  assert.equal(summary.status, "outcome_unknown"); assert.equal(summary.threadId, "thread-1");
  assert.equal(summary.needsController, true); assert.equal(summary.controllerRequest.truncated, true);
  assert.equal(summary.controllerRequest.question.length, 512);
  assert.equal(summary.evidenceCount, 1); assert.equal(summary.artifactCount, 1);
  assert.equal(summary.lastMessage, undefined); assert.equal(summary.authority, undefined);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(detailed).length / 10);
});

test("status --summary is wired through the CLI and preserves unknown-outcome exit semantics", async () => {
  const record = { ...contract(), status: "outcome_unknown", phase: "needs-reconciliation",
    admissionId: "admission-a", threadId: "thread-a", turnId: "turn-a",
    lastMessage: "verbose result", evidenceRefs: ["evidence-1"] };
  const dependencies = {
    readStateWithoutCreating: async () => ({ schemaVersion: 1, lanes: [record], updatedAt: null }),
    inspectBranch: async () => "fixture",
    probeExistingSupervisor: async () => ({ health: "unknown", protocol: "unknown" })
  };
  for (const compact of [true, false]) {
    let output = ""; let errors = "";
    const code = await runCli(["status", "--json", ...(compact ? ["--summary"] : [])], {
      stdout: value => { output += value; }, stderr: value => { errors += value; }, dependencies
    });
    assert.equal(errors, ""); assert.equal(code, 5);
    const payload = JSON.parse(output);
    assert.equal(payload.lanes[0].threadId, "thread-a");
    assert.equal(payload.selection.hasOutcomeUnknown, true);
    assert.equal(payload.summaryOnly, compact ? true : undefined);
    assert.equal(payload.lanes[0].lastMessage, compact ? undefined : "verbose result");
  }
});

test("pre-ack turn-only events are drained before later terminal events, not after them", async () => {
  const b = broker(); const original = b.request.bind(b); let runtime;
  b.request = async (method, params) => {
    if (method !== "turn/start") return original(method, params);
    runtime.handleNotification({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    runtime.handleNotification({ method: "item/started", params: { threadId: "thread-a", turnId: "turn-1", item: { type: "commandExecution" } } });
    runtime.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } } });
    return { turn: { id: "turn-1" } };
  };
  runtime = new FleetRuntime(b); await runtime.startLane(contract());
  assert.equal(runtime.inspectLane("lane-a").status, "cancelled");
  assert.equal(runtime.inspectLane("lane-a").turnId, "turn-1");
});
