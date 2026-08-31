import assert from "node:assert/strict";
import test from "node:test";

import {
  createScheduler,
  recoverPersistedRecords
} from "../plugins/fleet/scripts/lib/scheduler.mjs";

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
  const resumeRecords = [];
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
      resumeRecords.push(structuredClone(record));
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
    resumeRecords,
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

test("failed follow-up persistence restores terminal state and writer capacity", async () => {
  const runtime = recordingRuntime();
  let failNextWrite = true;
  const scheduler = createScheduler({
    runtime,
    store: {
      async write() {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("follow-up state unavailable");
        }
      }
    },
    limits: { maxActive: 1, maxWritersPerCheckout: 1, staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath: "C:\\workspace\\persisted",
    initialRecords: [{
      ...writer("persisted-writer", "shared"),
      status: "complete",
      phase: "complete",
      threadId: "thread-persisted-writer",
      turnId: "turn-persisted-writer",
      enqueuedAt: "2026-08-19T10:00:00.000Z",
      startedAt: "2026-08-19T10:00:01.000Z",
      finishedAt: "2026-08-19T10:00:02.000Z"
    }]
  });

  await assert.rejects(
    scheduler.continue("persisted-writer", "Check the second pass."),
    /follow-up state unavailable/iu
  );
  const restored = scheduler.snapshot().history.find((lane) => lane.id === "persisted-writer");
  assert.equal(restored.status, "complete");
  assert.equal(restored.phase, "complete");
  assert.equal(restored.finishedAt, "2026-08-19T10:00:02.000Z");

  const replacement = scheduler.enqueue(writer("replacement-writer", "shared"));
  await nextTurn();
  assert.deepEqual(runtime.starts, ["replacement-writer"]);
  await replacement;
});

test("controller-blocked lanes resume on the same persisted Codex thread", async () => {
  const runtime = recordingRuntime();
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath: "C:\\workspace\\persisted",
    initialRecords: [{
      ...reader("controller-blocked", "persisted"),
      status: "blocked",
      phase: "needs-controller",
      threadId: "thread-controller-blocked",
      turnId: "turn-controller-blocked",
      controllerRequest: {
        kind: "new_authority",
        question: "A controller decision is required."
      },
      stopReason: null,
      automaticContinuations: 2,
      enqueuedAt: "2026-08-19T10:00:00.000Z",
      startedAt: "2026-08-19T10:00:01.000Z",
      finishedAt: "2026-08-19T10:00:02.000Z"
    }]
  });

  const continued = await scheduler.continue(
    "controller-blocked",
    "The controller supplied the missing bounded input."
  );

  assert.equal(continued.status, "running");
  assert.equal(runtime.resumeRecords[0].status, "blocked");
  assert.equal(runtime.resumeRecords[0].phase, "needs-controller");
  assert.equal(runtime.resumeRecords[0].threadId, "thread-controller-blocked");
});

test("structured outcome evidence survives scheduler recovery", () => {
  const recovered = recoverPersistedRecords([{
    ...reader("structured-history", "persisted"),
    status: "complete",
    phase: "complete",
    outcome: "accomplished",
    workPerformed: ["Updated the implementation."],
    evidenceRefs: ["tests/runtime.test.mjs"],
    verification: ["Focused tests passed."],
    artifactRefs: ["src/runtime.mjs"],
    commitRefs: ["abcdef1"],
    configChanges: ["config/fleet.json"],
    outcomeDiagnostics: {
      code: "invalid_lane_outcome",
      missing: [],
      unknown: [],
      invalid: ["commitRefs:deadbee"],
      rawOutput: "must not survive"
    },
    controllerRequest: null,
    stopReason: null,
    automaticContinuations: 1,
    threadId: "thread-structured-history",
    turnId: "turn-structured-history",
    enqueuedAt: "2026-08-19T10:00:00.000Z",
    startedAt: "2026-08-19T10:00:01.000Z",
    finishedAt: "2026-08-19T10:00:02.000Z"
  }])[0];

  assert.equal(recovered.outcome, "accomplished");
  assert.deepEqual(recovered.workPerformed, ["Updated the implementation."]);
  assert.deepEqual(recovered.evidenceRefs, ["tests/runtime.test.mjs"]);
  assert.deepEqual(recovered.verification, ["Focused tests passed."]);
  assert.deepEqual(recovered.artifactRefs, ["src/runtime.mjs"]);
  assert.deepEqual(recovered.commitRefs, ["abcdef1"]);
  assert.deepEqual(recovered.configChanges, ["config/fleet.json"]);
  assert.deepEqual(recovered.outcomeDiagnostics, {
    code: "invalid_lane_outcome",
    missing: [],
    unknown: [],
    invalid: ["commitRefs:deadbee"]
  });
  assert.equal(recovered.automaticContinuations, 1);
});

test("a crash-window snapshot preserves the immutable terminal result and pending attempt", async () => {
  const runtime = recordingRuntime();
  let acceptContinuation;
  runtime.resumeLane = (...args) => new Promise((resolve) => {
    acceptContinuation = () => resolve({
      ...args[0],
      status: "running",
      phase: "continuing",
      turnId: "turn-after-acceptance"
    });
  });
  const store = memoryStore();
  const scheduler = createScheduler({
    runtime,
    store,
    limits: { staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath: "C:\\workspace\\persisted",
    initialRecords: [{
      ...reader("crash-safe-terminal", "shared"),
      status: "complete",
      phase: "complete",
      threadId: "thread-crash-safe-terminal",
      turnId: "turn-original",
      lastMessage: "Original completed result remains available.",
      enqueuedAt: "2026-08-19T10:00:00.000Z",
      startedAt: "2026-08-19T10:00:01.000Z",
      finishedAt: "2026-08-19T10:00:02.000Z"
    }]
  });

  const continuing = scheduler.continue("crash-safe-terminal", "Continue the bounded task.");
  await nextTurn();
  const crashWindow = store.writes.at(-1).history[0];

  assert.equal(crashWindow.status, "complete");
  assert.equal(crashWindow.turnId, "turn-original");
  assert.equal(crashWindow.lastMessage, "Original completed result remains available.");
  assert.equal(crashWindow.pendingContinuation.state, "starting");

  const recovered = createScheduler({
    runtime: recordingRuntime(),
    store: memoryStore(),
    limits: { staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath: "C:\\workspace\\persisted",
    initialRecords: [crashWindow]
  });
  const retained = recovered.snapshot().history[0];
  assert.equal(retained.status, "complete");
  assert.equal(retained.turnId, "turn-original");
  assert.equal(retained.pendingContinuation.state, "outcome_unknown");
  await assert.rejects(
    recovered.continue("crash-safe-terminal", "Do not duplicate the uncertain turn."),
    /pending continuation.*reconciliation/iu
  );

  acceptContinuation();
  await continuing;
});

test("a rejected runtime continuation preserves the previous terminal record", async () => {
  const runtime = recordingRuntime();
  runtime.resumeLane = async () => {
    throw new Error("thread already has an active writer");
  };
  const scheduler = createScheduler({
    runtime,
    store: memoryStore(),
    limits: { maxActive: 1, maxWritersPerCheckout: 1, staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath: "C:\\workspace\\persisted",
    initialRecords: [{
      ...reader("immutable-success", "shared"),
      status: "complete",
      phase: "complete",
      threadId: "thread-immutable-success",
      turnId: "turn-immutable-success",
      lastMessage: "The verified research report remains available.",
      enqueuedAt: "2026-08-19T10:00:00.000Z",
      startedAt: "2026-08-19T10:00:01.000Z",
      finishedAt: "2026-08-19T10:00:02.000Z"
    }]
  });

  await assert.rejects(
    scheduler.continue("immutable-success", "Continue only if the thread is writable."),
    /active writer/iu
  );

  const restored = scheduler.snapshot().history.find((lane) => lane.id === "immutable-success");
  assert.equal(restored.status, "complete");
  assert.equal(restored.phase, "complete");
  assert.equal(restored.turnId, "turn-immutable-success");
  assert.equal(restored.lastMessage, "The verified research report remains available.");
  assert.equal(restored.exitReason, null);
  assert.equal(restored.finishedAt, "2026-08-19T10:00:02.000Z");
  assert.deepEqual(scheduler.snapshot().active, []);
});

test("an acceptance-unknown continuation preserves the terminal record and reconciliation lock", async () => {
  const runtime = recordingRuntime();
  runtime.resumeLane = async () => {
    const error = new Error("turn/start response was lost");
    error.requestAcceptance = "unknown";
    throw error;
  };
  const store = memoryStore();
  const scheduler = createScheduler({
    runtime,
    store,
    limits: { staggerMs: 0 },
    clock: deterministicClock(),
    workspacePath: "C:\\workspace\\persisted",
    initialRecords: [{
      ...reader("uncertain-follow-up", "shared"),
      status: "complete",
      phase: "complete",
      threadId: "thread-uncertain-follow-up",
      turnId: "turn-original",
      lastMessage: "Original terminal evidence.",
      enqueuedAt: "2026-08-19T10:00:00.000Z",
      startedAt: "2026-08-19T10:00:01.000Z",
      finishedAt: "2026-08-19T10:00:02.000Z"
    }]
  });

  await assert.rejects(
    scheduler.continue("uncertain-follow-up", "Perform the bounded continuation once."),
    /response was lost/iu
  );
  const retained = scheduler.snapshot().history[0];
  assert.equal(retained.status, "complete");
  assert.equal(retained.turnId, "turn-original");
  assert.equal(retained.lastMessage, "Original terminal evidence.");
  assert.equal(retained.pendingContinuation.state, "outcome_unknown");
  assert.equal(store.writes.at(-1).history[0].pendingContinuation.state, "outcome_unknown");
  await assert.rejects(
    scheduler.continue("uncertain-follow-up", "Never repeat without reconciliation."),
    /requires reconciliation/iu
  );
});

test("an acceptance-unknown initial turn is persisted as unknown instead of failed", async () => {
  const runtime = recordingRuntime();
  runtime.startLane = async () => {
    const error = new Error("initial turn/start response was lost");
    error.requestAcceptance = "unknown";
    throw error;
  };
  runtime.inspectLane = (id) => id === "uncertain-initial"
    ? {
      id,
      status: "outcome_unknown",
      phase: "outcome_unknown",
      threadId: "thread-uncertain-initial",
      turnId: null,
      exitReason: "initial turn/start response was lost"
    }
    : null;
  const store = memoryStore();
  const scheduler = createScheduler({
    runtime,
    store,
    limits: { staggerMs: 0 },
    clock: deterministicClock()
  });

  await assert.rejects(
    scheduler.enqueue(reader("uncertain-initial", "shared")),
    /response was lost/iu
  );
  const retained = scheduler.snapshot().history[0];
  assert.equal(retained.status, "outcome_unknown");
  assert.equal(retained.phase, "outcome_unknown");
  assert.equal(retained.threadId, "thread-uncertain-initial");
  assert.equal(store.writes.at(-1).history[0].status, "outcome_unknown");
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

test("interrupted mutable capability lanes become external unknown outcomes", () => {
  const cases = [
    { id: "image-interrupted", image: { generate: true, edit: false } },
    { id: "browser-interrupted", browser: { inspect: true, mutate: true } },
    { id: "database-interrupted", database: { read: true, write: true } }
  ];

  for (const { id, ...grants } of cases) {
    const recovered = createScheduler({
      runtime: recordingRuntime(),
      store: memoryStore(),
      limits: { staggerMs: 0 },
      clock: deterministicClock(),
      initialRecords: [{
        ...writer(id, "mutable-surface", {
          authority: {
            sandbox: "workspace-write",
            network: "off",
            process: { start: true, stopOwned: true },
            ...grants
          }
        }),
        status: "running",
        phase: "running",
        enqueuedAt: "2026-08-19T10:00:00.000Z",
        startedAt: "2026-08-19T10:00:01.000Z"
      }]
    }).snapshot().history[0];

    assert.equal(recovered.externalEffect, true, id);
    assert.equal(recovered.status, "outcome_unknown", id);
  }
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

test("every lane keeps immutable admission provenance across persistence", async () => {
  const store = memoryStore();
  const scheduler = createScheduler({
    runtime: recordingRuntime(),
    store,
    limits: { staggerMs: 0 },
    clock: deterministicClock()
  });

  const completed = await scheduler.enqueue({
    ...reader("provenance", "safe"),
    admissionSource: "fleet-supervisor"
  });
  const recovered = recoverPersistedRecords([completed])[0];

  assert.match(completed.admissionId, /^[a-f0-9-]{36}$/u);
  assert.equal(completed.admissionSource, "fleet-supervisor");
  assert.equal(completed.admittedAt, completed.enqueuedAt);
  assert.equal(recovered.admissionId, completed.admissionId);
  assert.equal(recovered.admissionSource, "fleet-supervisor");
  assert.equal(recovered.admittedAt, completed.admittedAt);
});
