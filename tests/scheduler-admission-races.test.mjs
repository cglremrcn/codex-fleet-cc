import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createScheduler } from "../plugins/fleet/scripts/lib/scheduler.mjs";
import { createControlPlane } from "../plugins/fleet/scripts/fleet-supervisor.mjs";

const workspacePath = path.resolve(".");
const workspaceKey = "a".repeat(32);
function contract(id, sandbox = "workspace-write") {
  return { id, role: "implementer", label: id, model: "gpt-5.6-sol", effort: "high",
    workspacePath, workspaceKey, prompt: "Inspect fixture",
    authority: { sandbox, process: { start: true } } };
}
function fixture(options = {}) {
  const records = new Map();
  const runtime = {
    async startLane(lane) {
      const record = { ...lane, status: "running", threadId: lane.id, turnId: `${lane.id}-1` };
      records.set(lane.id, record);
      return record;
    },
    inspectLane: id => records.get(id) ?? null,
    async continueLane(id) {
      await options.beforeContinue?.();
      const record = { ...records.get(id), status: "running", turnId: `${id}-2` };
      records.set(id, record);
      return record;
    },
    async resumeLane() {}, async interruptLane() {}, async close() {}
  };
  const scheduler = createScheduler({ runtime, workspacePath,
    store: { write: async () => options.write?.() },
    limits: { maxActive: options.maxActive ?? 3, staggerMs: 0 } });
  return { runtime, scheduler, records };
}
async function complete(f, id, sandbox) {
  await f.scheduler.enqueue(contract(id, sandbox));
  f.records.get(id).status = "complete";
  await f.scheduler.reconcile();
}

test("concurrent continuations reserve the physical workspace writer before dispatch", async () => {
  const f = fixture({ beforeContinue: () => new Promise(resolve => setImmediate(resolve)) });
  await complete(f, "a"); await complete(f, "b");
  const results = await Promise.allSettled([
    f.scheduler.continue("a", "Continue"), f.scheduler.continue("b", "Continue")
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /writer/);
  assert.equal(f.scheduler.snapshot().active.length, 1);
});

test("read-only continuations respect maxActive including pending dispatches", async () => {
  const f = fixture({ maxActive: 1 });
  await complete(f, "a", "read-only"); await complete(f, "b", "read-only");
  const results = await Promise.allSettled([
    f.scheduler.continue("a", "Continue"), f.scheduler.continue("b", "Continue")
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /capacity/);
});

test("new admissions cannot overtake a pending continuation writer", async () => {
  let release;
  const f = fixture({ beforeContinue: () => new Promise(resolve => { release = resolve; }) });
  await complete(f, "a");
  const continuation = f.scheduler.continue("a", "Continue");
  await new Promise(resolve => setImmediate(resolve));
  const admission = f.scheduler.enqueue(contract("b"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.has("b"), false);
  release(); await continuation;
  f.records.get("a").status = "complete";
  await f.scheduler.reconcile(); await admission;
  assert.equal(f.scheduler.snapshot().active[0].id, "b");
});

test("acceptance-unknown continuation retains writer capacity across state recovery", async () => {
  const f = fixture({ beforeContinue: () => {
    throw Object.assign(new Error("response lost"), { requestAcceptance: "unknown" });
  } });
  await complete(f, "a"); await complete(f, "b");
  await assert.rejects(f.scheduler.continue("a", "Continue"), /response lost/);
  await assert.rejects(f.scheduler.continue("b", "Continue"), /writer/);
  const restored = createScheduler({ runtime: f.runtime, workspacePath,
    store: { write: async () => {} }, initialRecords: f.scheduler.snapshot().history });
  await assert.rejects(restored.continue("b", "Continue"), /writer/);
});

test("reconciliation retains a lane while its initial runtime dispatch is pending", async () => {
  const f = fixture();
  const original = f.runtime.startLane;
  let release;
  f.runtime.startLane = async lane => {
    await new Promise(resolve => { release = resolve; });
    return original(lane);
  };
  const admission = f.scheduler.enqueue(contract("a"));
  await new Promise(resolve => setImmediate(resolve));
  const reconciliation = f.scheduler.reconcile();
  assert.equal(f.scheduler.snapshot().active[0]?.id, "a");
  assert.equal(f.scheduler.snapshot().history.length, 0);
  release(); await admission; await reconciliation;
  assert.equal(f.scheduler.snapshot().active[0].status, "running");
});

for (const failure of ["persistence", "runtime"]) {
  test(`rejected continuation releases its reservation after ${failure} failure`, async () => {
    let reject = false;
    const fail = () => { if (reject) { reject = false; throw new Error("fixture rejection"); } };
    const f = fixture({ maxActive: 1,
      ...(failure === "runtime" ? { beforeContinue: fail } : { write: fail }) });
    await complete(f, "a"); await complete(f, "b");
    reject = true;
    await assert.rejects(f.scheduler.continue("a", "Continue"), /fixture rejection/);
    await f.scheduler.continue("b", "Continue");
    assert.equal(f.scheduler.snapshot().active[0].id, "b");
  });
}

test("supervisor advances a batch larger than capacity without an external status poll", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-admission-races-"));
  const f = fixture();
  const original = f.runtime.startLane;
  f.runtime.startLane = async lane => {
    const record = await original(lane);
    setTimeout(() => { record.status = "complete"; }, 10);
    return record;
  };
  const control = createControlPlane({ dataDir, workspaceKey, workspacePath,
    createRuntime: async () => f.runtime });
  t.after(async () => { await control.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const lanes = ["a", "b"].map(id => {
    const { workspacePath: unusedPath, workspaceKey: unusedKey, ...lane } = contract(id, "read-only");
    return lane;
  });
  let timer;
  try {
    await Promise.race([
      control.handle("start", { schemaVersion: 1, workspacePath, lanes,
        limits: { maxActive: 1, staggerMs: 0 } }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Batch admission stalled")), 1000);
      })
    ]);
    assert.equal(f.records.size, 2);
  } finally { clearTimeout(timer); }
});
