import assert from "node:assert/strict";
import test from "node:test";

import { createScheduler } from "../plugins/fleet/scripts/lib/scheduler.mjs";

const WORKSPACE_KEY = "0123456789abcdef0123456789abcdef";

function contract(id, checkoutKey, sandbox = "read-only", overrides = {}) {
  return {
    id,
    role: sandbox === "workspace-write" ? "implementer" : "investigator",
    label: `Lane ${id}`,
    workspaceKey: WORKSPACE_KEY,
    workspacePath: `C:\\workspace\\${checkoutKey}`,
    checkoutKey,
    model: "gpt-5.6-sol",
    effort: "high",
    authority: {
      sandbox,
      network: "off",
      process: { start: true, stopOwned: true }
    },
    prompt: `Run ${id}`,
    ...overrides
  };
}

function writer(id, checkoutKey, overrides) {
  return contract(id, checkoutKey, "workspace-write", overrides);
}

function reader(id, checkoutKey, overrides) {
  return contract(id, checkoutKey, "read-only", overrides);
}

function recordingRuntime() {
  const lanes = new Map();
  const starts = [];
  const resumes = [];
  const interrupts = [];
  let active = 0;
  let peak = 0;
  const writerCounts = new Map();
  const writerPeaks = new Map();

  return {
    async startLane(lane) {
      active += 1;
      peak = Math.max(peak, active);
      const isWriter = lane.authority.sandbox === "workspace-write";
      if (isWriter) {
        const next = (writerCounts.get(lane.checkoutKey) ?? 0) + 1;
        writerCounts.set(lane.checkoutKey, next);
        writerPeaks.set(lane.checkoutKey, Math.max(writerPeaks.get(lane.checkoutKey) ?? 0, next));
      }
      const state = {
        ...lane,
        status: "running",
        threadId: `thread-${lane.id}`,
        turnId: `turn-${lane.id}`,
        isWriter
      };
      lanes.set(lane.id, state);
      starts.push(lane.id);
      return { ...state };
    },
    async resumeLane(record, workspacePath, message) {
      const state = {
        ...record,
        workspacePath,
        status: "running",
        turnId: `turn-resumed-${record.id}`
      };
      lanes.set(record.id, state);
      resumes.push({ id: record.id, workspacePath, message });
      return { ...state };
    },
    async continueLane(id, message) {
      const lane = lanes.get(id);
      lane.status = "running";
      lane.turnId = `turn-continued-${id}`;
      resumes.push({ id, workspacePath: lane.workspacePath, message });
      return { ...lane };
    },
    inspectLane(id) {
      const lane = lanes.get(id);
      return lane ? { ...lane } : null;
    },
    listLanes() {
      return [...lanes.values()].map((lane) => ({ ...lane }));
    },
    async interruptLane(id) {
      interrupts.push(id);
      const lane = lanes.get(id);
      lane.status = "cancelled";
      return { ...lane };
    },
    complete(id, status = "complete") {
      const lane = lanes.get(id);
      if (!lane || lane.status !== "running") {
        return;
      }
      lane.status = status;
      active -= 1;
      if (lane.isWriter) {
        writerCounts.set(lane.checkoutKey, writerCounts.get(lane.checkoutKey) - 1);
      }
    },
    replaceThread(id, threadId) {
      lanes.get(id).threadId = threadId;
    },
    maxConcurrent() {
      return peak;
    },
    maxWriters(checkoutKey) {
      return writerPeaks.get(checkoutKey) ?? 0;
    },
    starts,
    resumes,
    interrupts
  };
}

function deterministicClock() {
  let milliseconds = 0;
  const sleeps = [];
  return {
    now: () => milliseconds,
    async sleep(duration) {
      sleeps.push(duration);
      milliseconds += duration;
    },
    sleeps
  };
}

function memoryStore() {
  const writes = [];
  return {
    async write(snapshot) {
      writes.push(structuredClone(snapshot));
    },
    writes
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("scheduler caps active lanes and serializes writers per checkout", async () => {
  const runtime = recordingRuntime();
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { maxActive: 3, maxWritersPerCheckout: 1, staggerMs: 0 },
    clock: deterministicClock()
  });

  const admitted = [
    scheduler.enqueue(writer("a", "checkout-1")),
    scheduler.enqueue(writer("b", "checkout-1")),
    scheduler.enqueue(reader("c", "checkout-1")),
    scheduler.enqueue(reader("d", "checkout-2"))
  ];
  await nextTurn();

  assert.equal(runtime.maxConcurrent(), 3);
  assert.equal(runtime.maxWriters("checkout-1"), 1);
  assert.deepEqual(runtime.starts, ["a", "c", "d"]);

  runtime.complete("a");
  runtime.complete("c");
  runtime.complete("d");
  await scheduler.reconcile();
  await Promise.all(admitted);

  assert.deepEqual(runtime.starts, ["a", "c", "d", "b"]);
  assert.equal(runtime.maxWriters("checkout-1"), 1);
});

test("a queued writer is not starved by a continuous reader stream", async () => {
  const runtime = recordingRuntime();
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { maxActive: 1, maxWritersPerCheckout: 1, staggerMs: 0 },
    clock: deterministicClock()
  });

  await scheduler.enqueue(reader("reader-first", "shared"));
  const waitingWriter = scheduler.enqueue(writer("writer-waiting", "shared"));
  const laterReader = scheduler.enqueue(reader("reader-later", "shared"));
  runtime.complete("reader-first");
  await scheduler.reconcile();
  await waitingWriter;

  assert.deepEqual(runtime.starts, ["reader-first", "writer-waiting"]);

  runtime.complete("writer-waiting");
  await scheduler.reconcile();
  await laterReader;
  assert.deepEqual(runtime.starts, ["reader-first", "writer-waiting", "reader-later"]);
});

test("lane starts are staggered without real sleeps", async () => {
  const runtime = recordingRuntime();
  const clock = deterministicClock();
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { maxActive: 3, maxWritersPerCheckout: 1, staggerMs: 150 },
    clock
  });

  await Promise.all([
    scheduler.enqueue(reader("one", "a")),
    scheduler.enqueue(reader("two", "b")),
    scheduler.enqueue(reader("three", "c"))
  ]);

  assert.deepEqual(clock.sleeps, [150, 150]);
  assert.equal(clock.now(), 300);
});

test("cancellation requires the exact recorded owned thread", async () => {
  const runtime = recordingRuntime();
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { staggerMs: 0 },
    clock: deterministicClock()
  });

  await scheduler.enqueue(reader("owned", "a"));
  await scheduler.cancel("owned");
  assert.deepEqual(runtime.interrupts, ["owned"]);

  await scheduler.enqueue(reader("changed", "b"));
  runtime.replaceThread("changed", "unrelated-thread");
  await assert.rejects(scheduler.cancel("changed"), /ownership/i);
  assert.deepEqual(runtime.interrupts, ["owned"]);
});

test("hydrated completed lanes continue through a fresh runtime", async () => {
  const runtime = recordingRuntime();
  const workspacePath = "C:\\workspace\\persisted";
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath,
    initialRecords: [{
      id: "persisted",
      role: "investigator",
      label: "Persisted lane",
      workspaceKey: WORKSPACE_KEY,
      checkoutKey: "persisted",
      model: "gpt-5.6-sol",
      effort: "high",
      authority: {
        sandbox: "read-only",
        network: "off",
        process: { start: true, stopOwned: true }
      },
      priority: "normal",
      status: "complete",
      phase: "complete",
      externalEffect: false,
      retryOf: null,
      reconciliationRef: null,
      threadId: "thread-persisted",
      turnId: "turn-persisted",
      enqueuedAt: "2026-08-19T10:00:00.000Z",
      startedAt: "2026-08-19T10:00:01.000Z",
      finishedAt: "2026-08-19T10:00:02.000Z"
    }]
  });

  const continued = await scheduler.continue("persisted", "Check the second pass.");

  assert.equal(continued.status, "running");
  assert.equal(continued.turnId, "turn-resumed-persisted");
  assert.deepEqual(runtime.resumes, [{
    id: "persisted",
    workspacePath,
    message: "Check the second pass."
  }]);
  assert.equal(scheduler.snapshot().history.length, 0);
  assert.equal(scheduler.snapshot().active.length, 1);
  assert.equal(scheduler.snapshot().active[0].authority.sandbox, "read-only");
});

test("cancel refuses a stale caller-pinned turn identity", async () => {
  const runtime = recordingRuntime();
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { staggerMs: 0 },
    clock: deterministicClock()
  });
  const started = await scheduler.enqueue(reader("pinned", "a"));

  await assert.rejects(scheduler.cancel("pinned", {
    threadId: started.threadId,
    turnId: "stale-turn"
  }), /target identity changed/i);
  assert.deepEqual(runtime.interrupts, []);
});

test("unknown external outcomes block retry until reconciliation evidence exists", async () => {
  const runtime = recordingRuntime();
  const store = memoryStore();
  const scheduler = createScheduler({
    runtime,
    store,
    limits: { staggerMs: 0 },
    clock: deterministicClock()
  });

  await scheduler.enqueue(writer("send-original", "outreach", {
    authority: {
      sandbox: "workspace-write",
      network: "live",
      process: { start: true, stopOwned: true },
      externalEffects: { send: true }
    }
  }));
  runtime.complete("send-original", "outcome_unknown");
  await scheduler.reconcile();

  await assert.rejects(
    scheduler.enqueue(writer("send-retry-denied", "outreach", {
      retryOf: "send-original"
    })),
    /reconciliation/i
  );
  await scheduler.enqueue(writer("send-retry-safe", "outreach", {
    retryOf: "send-original",
    reconciliationRef: "evidence/provider-status.json"
  }));

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.history.find((lane) => lane.id === "send-original").status, "outcome_unknown");
  assert.ok(store.writes.length > 0);
  assert.doesNotMatch(JSON.stringify(store.writes), /Run send-original/);
});

test("state persistence failure rolls back admission before Codex starts", async () => {
  const runtime = recordingRuntime();
  let writeCount = 0;
  const store = {
    async write() {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("state device unavailable");
      }
    }
  };
  const scheduler = createScheduler({
    runtime,
    store,
    limits: { staggerMs: 0 },
    clock: deterministicClock()
  });

  await assert.rejects(
    scheduler.enqueue(reader("state-failure", "safe")),
    /state device unavailable/i
  );

  assert.deepEqual(runtime.starts, []);
  assert.deepEqual(scheduler.snapshot().active, []);
  assert.equal(
    scheduler.snapshot().history.find((lane) => lane.id === "state-failure").status,
    "failed"
  );
});
