import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMachineControl } from "../plugins/fleet/scripts/lib/control-service.mjs";
import { createControlPlane } from "../plugins/fleet/scripts/fleet-supervisor.mjs";
import { describeControl, validateControlOperation, validateControlRequest } from "../plugins/fleet/scripts/lib/control-contract.mjs";
import { runControlCli, controlFailure } from "../plugins/fleet/scripts/lib/control-cli.mjs";
import { createObservationFeed, createObservationAssembler } from "../plugins/fleet/scripts/lib/control-observation.mjs";

const key = "a".repeat(32);
const lane = (id, extra = {}) => ({ id, status: "running", phase: "coding", admissionId: `admission-${id}`, turnId: `turn-${id}`, ...extra });
const request = (operation, params = {}, workspacePath = process.cwd()) => ({ schemaVersion: 1, requestId: "test-1", operation, workspacePath, params });
function readAll(feed, snapshot, params = {}, previous) {
  let page = feed.observe(snapshot, params);
  const assembler = createObservationAssembler(previous); const pages = [];
  for (let n = 0; n < 257; n++) {
    pages.push(page);
    const result = assembler.accept(page);
    if (result) return { pages, result };
    page = feed.observe(null, { nextPage: page.nextPage });
  }
  throw new Error("unbounded observation pagination");
}

test("controller discovery is small, versioned and discloses one schema at a time", () => {
  const index = describeControl();
  assert.equal(index.protocol, "fleet.control.v1");
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 2600);
  assert.ok(index.operations.every(op => !op.paramsSchema));
  assert.equal(describeControl("observe").paramsSchema.additionalProperties, false);
  assert.equal(index.operations.some(op => /approve|adopt|eval/.test(op.name)), false);
});

test("every published example obeys the live validator, not a separate approximate schema", () => {
  for (const { name } of describeControl().operations) {
    const doc = describeControl(name);
    if (doc.exampleParams) assert.doesNotThrow(() => validateControlOperation(name, doc.exampleParams));
  }
});

test("unknown/deep/oversized/prototype/cyclic control input fails without echoing supplied values", () => {
  for (const bad of [request("observe", { maxBytes: 1 }), request("observe", { maxBytes: 3.2 }), request("observe", { secret: "DO_NOT_ECHO" }), request("run-shell"), { ...request("observe"), schemaVersion: 2 }, request("observe", JSON.parse('{"__proto__": {"admin":true}}'))]) {
    assert.throws(() => validateControlRequest(bad), error => !error.message.includes("DO_NOT_ECHO"));
  }
  const cycle = {}; cycle.a = cycle;
  assert.throws(() => validateControlRequest(request("start", { contract: cycle })), /cyclic/);
  let deep = {}; for (let i = 0; i < 20; i++) deep = { a: deep };
  assert.throws(() => validateControlRequest(request("start", { contract: deep })), /budget/);
  assert.throws(() => validateControlRequest(request("continue", { laneId: "a", message: "界".repeat(50000) })), /budget/);
});

test("unchanged observations are tiny and ignore timestamp churn, labels and usage unless requested", () => {
  const feed = createObservationFeed({ workspaceKey: key });
  const snapshot = { lanes: Array.from({ length: 100 }, (_, i) => lane(`l-${i}`, { lastMessage: "a".repeat(8192), updatedAt: 1, tokenUsage: { total: 50 } })) };
  const first = readAll(feed, snapshot, { maxBytes: 8192 });
  const second = readAll(feed, { lanes: snapshot.lanes.map(l => ({ ...l, updatedAt: 2, tokenUsage: { total: 100 } })) }, { cursor: first.result.cursor }, first.result);
  assert.equal(second.pages.length, 1);
  assert.deepEqual(second.pages[0].changes, []);
  assert.ok(Buffer.byteLength(JSON.stringify(second.pages[0])) < 1000);
  assert.equal(second.result.lanes.length, 100);
  assert.equal(JSON.stringify(second).includes("a".repeat(100)), false);
});

test("changed lanes, removed/archive rows and pending requests are not swallowed by deltas", () => {
  const feed = createObservationFeed({ workspaceKey: key });
  const before = readAll(feed, { lanes: [lane("a"), lane("b"), lane("c")] }).result;
  const after = readAll(feed, { lanes: [lane("a", { pendingApprovalCount: 1 }), lane("c", { archivedAt: "now" }), lane("d", { status: "complete", verification: ["claim"] })] }, { cursor: before.cursor }, before);
  assert.deepEqual(after.result.lanes.map(l => l.id).sort(), ["a", "d"]);
  assert.equal(after.result.totals.attention, 1);
  assert.equal(after.result.totals.awaitingVerification, 1);
  assert.equal(after.result.totals.archived, 1);
  assert.equal(after.pages[0].mode, "delta");
});

test("usage is opt-in cumulative telemetry; projection cursors cannot silently switch options", () => {
  const feed = createObservationFeed({ workspaceKey: key });
  const source = { lanes: [lane("a", { tokenUsage: { input: 100, output: 20, total: 120, cachedInput: 50 } })] };
  const first = readAll(feed, source, { includeUsage: true }).result;
  const second = readAll(feed, source, { cursor: first.cursor, includeUsage: true }, first);
  assert.equal(second.result.lanes[0].reportedUsage.total, 120);
  assert.equal(second.pages[0].changes.length, 0);
  assert.throws(() => feed.observe(source, { cursor: first.cursor }), /projection/);
});

test("partial pages pin a frozen target while current state moves; only final page advances cursor", () => {
  const feed = createObservationFeed({ workspaceKey: key });
  const source = { lanes: Array.from({ length: 48 }, (_, i) => lane(`agent-${i}`)) };
  let page = feed.observe(source, { maxBytes: 2048 });
  const assembler = createObservationAssembler();
  assert.equal(page.cursor, null);
  assert.equal(assembler.accept(page), null);
  feed.observe({ lanes: [lane("newer-state")] });
  let totalPages = 1;
  while (!page.done) {
    page = feed.observe(null, { nextPage: page.nextPage }); totalPages++;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
    assembler.accept(page);
  }
  assert.ok(totalPages > 1);
  assert.equal(assembler.result().lanes.length, 48);
  assert.equal(assembler.result().lanes.some(l => l.id === "newer-state"), false);
});

test("cursor cache eviction and supervisor restart explicitly reset instead of silently skipping changes", () => {
  const feed = createObservationFeed({ workspaceKey: key, maxSnapshots: 1 });
  const a = readAll(feed, { lanes: [lane("a")] }).result;
  feed.observe({ lanes: [lane("b")] });
  const c = readAll(feed, { lanes: [lane("c")] }, { cursor: a.cursor }, a);
  assert.equal(c.pages[0].resetReason, "cursor-evicted");
  assert.deepEqual(c.result.lanes.map(l => l.id), ["c"]);
  const restarted = createObservationFeed({ workspaceKey: key });
  const d = readAll(restarted, { lanes: [lane("d")] }, { cursor: c.result.cursor }, c.result);
  assert.equal(d.pages[0].resetReason, "supervisor-restarted");
});

test("cross-workspace, tampered or evicted page tokens fail; callers discard incomplete batches", () => {
  const feed = createObservationFeed({ workspaceKey: key, maxBatches: 1 });
  const source = { lanes: Array.from({ length: 10 }, (_, i) => lane(`a-${i}`)) };
  const first = feed.observe(source, { maxBytes: 2048 });
  assert.throws(() => feed.observe(source, { nextPage: `${first.nextPage}a` }), /Malformed/);
  const other = createObservationFeed({ workspaceKey: "b".repeat(32) });
  assert.throws(() => other.observe(null, { nextPage: first.nextPage }), /epoch|changed/);
  feed.observe({ lanes: [] });
  assert.throws(() => feed.observe(null, { nextPage: first.nextPage }), /evicted/);
  assert.throws(() => feed.observe(source, { cursor: other.observe({ lanes: [] }).cursor }), /workspace/);
});

test("partial/mixed/reordered pages cannot be applied as a complete controller state", () => {
  const feed = createObservationFeed({ workspaceKey: key });
  const page = feed.observe({ lanes: Array.from({ length: 10 }, (_, i) => lane(`a-${i}`)) }, { maxBytes: 2048 });
  const assembler = createObservationAssembler();
  assert.equal(assembler.accept(page), null);
  assert.equal(assembler.result(), null);
  assert.throws(() => assembler.accept(page), /out-of-order/);
  const wrong = { ...feed.observe(null, { nextPage: page.nextPage }), batchId: "wrong" };
  assert.throws(() => assembler.accept(wrong), /Mixed/);
});

test("malformed snapshots and duplicate identities are not normalized into an empty fleet", () => {
  const feed = createObservationFeed({ workspaceKey: key });
  for (const snapshot of [{}, null, { lanes: [lane("same"), lane("same")] }, { lanes: [lane("x", { status: "made-up" })] }]) assert.throws(() => feed.observe(snapshot));
});

test("observation caches have explicit count and byte bounds under changing state", () => {
  const feed = createObservationFeed({ workspaceKey: key, maxSnapshots: 3, maxBatches: 2, maxRetainedBytes: 65536 });
  for (let i = 0; i < 100; i++) feed.observe({ lanes: [lane(`lane-${i}`)] });
  assert.ok(feed.stats().retainedBytes <= 65536);
  assert.ok(feed.stats().snapshots <= 3);
  assert.ok(feed.stats().batches <= 2);
  feed.dispose(); assert.equal(feed.stats().retainedBytes, 0);
});

test("describe from the real CLI creates no state/runtime and always returns one JSON envelope", async () => {
  const output = []; let calls = 0;
  const code = await runControlCli(["describe", "--json"], { stdout: x => output.push(x), dependencies: { ensureSupervisor: () => { calls++; } } });
  assert.equal(code, 0); assert.equal(calls, 0); assert.equal(output.length, 1); assert.equal(JSON.parse(output[0]).ok, true);
  for (const stdin of [Buffer.from([0xff]), '{"schemaVersion":2}', '[]', '{}\n{}']) {
    output.length = 0;
    assert.equal(await runControlCli(["--stdin"], { stdin, stdout: x => output.push(x) }), 2);
    assert.equal(output.length, 1); assert.equal(JSON.parse(output[0]).ok, false);
  }
});

test("control errors never disclose raw exception output and write timeouts cannot be marked retry-safe", () => {
  const result = controlFailure(request("continue", { laneId: "a", message: "hello" }), { message: "secret-do-not-echo", requestSent: true, code: "SUPERVISOR_RESPONSE_TIMEOUT" });
  assert.equal(result.error.requestAcceptance, "unknown");
  assert.equal(result.error.retry, "reconcile-first");
  assert.equal(JSON.stringify(result).includes("secret-do-not-echo"), false);
});

test("machine wait returns after a cursor change without starting the runtime", async () => {
  let current = { lanes: [{ id: "a", status: "running" }] }, legacyCalls = 0;
  const service = createMachineControl({ workspacePath: process.cwd(), workspaceKey: key,
    snapshot: async () => current, callLegacy: async () => { legacyCalls++; throw new Error("not for observations"); } });
  const initial = await service.handle(request("observe", {}));
  current = { lanes: [{ id: "a", status: "complete" }] };
  const changed = await service.handle(request("wait", { cursor: initial.data.cursor, timeoutMs: 100 }));
  assert.equal(changed.data.changed, true); assert.equal(changed.data.reason, "state-changed");
  assert.equal(legacyCalls, 0); service.dispose();
});

test("real supervisor control observation never initializes the Codex runtime; wrong workspace refuses", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-control-zero-turn-"));
  let runtimes = 0;
  const plane = createControlPlane({ dataDir: root, workspacePath: root, workspaceKey: key, token: "c".repeat(64), createRuntime: () => { runtimes++; throw new Error("no runtime for observation"); } });
  t.after(async () => { await plane.close(); await fs.rm(root, { recursive: true, force: true }); });
  const result = await plane.handle("control", request("observe", {}, root));
  assert.equal(result.ok, true); assert.equal(result.data.totals.visible, 0); assert.equal(runtimes, 0);
  const invalid = await plane.handle("control", request("observe", {}, path.join(root, "wrong")));
  assert.equal(invalid.ok, false); assert.equal(runtimes, 0);
});
