import { normalizeAuthority } from "./authority.mjs";
import { createLane } from "./domain.mjs";

const DEFAULT_LIMITS = Object.freeze({
  maxActive: 3,
  maxWritersPerCheckout: 1,
  staggerMs: 150
});
const PRIORITY_ORDER = Object.freeze(["high", "normal", "low"]);
const TERMINAL_STATUSES = new Set([
  "complete",
  "verified",
  "blocked",
  "failed",
  "cancelled",
  "outcome_unknown"
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function defaultClock() {
  return {
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  };
}

function positiveInteger(value, fallback, label, allowZero = false) {
  const candidate = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(candidate) || candidate < minimum) {
    throw new TypeError(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return candidate;
}

function normalizeLimits(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Scheduler limits must be an object.");
  }
  return Object.freeze({
    maxActive: positiveInteger(
      input.maxActive,
      DEFAULT_LIMITS.maxActive,
      "limits.maxActive"
    ),
    maxWritersPerCheckout: positiveInteger(
      input.maxWritersPerCheckout,
      DEFAULT_LIMITS.maxWritersPerCheckout,
      "limits.maxWritersPerCheckout"
    ),
    staggerMs: positiveInteger(
      input.staggerMs,
      DEFAULT_LIMITS.staggerMs,
      "limits.staggerMs",
      true
    )
  });
}

function assertDependency(value, methods, label) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label} is required.`);
  }
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`${label}.${method} must be a function.`);
    }
  }
}

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(`${label} must contain between 1 and 256 safe characters.`);
  }
  return value;
}

function hasExternalEffect(authority) {
  return Object.values(authority.externalEffects).some(Boolean);
}

function publicRecord(item, status = item.status) {
  return Object.freeze({
    id: item.id,
    role: item.role,
    label: item.label,
    workspaceKey: item.workspaceKey,
    checkoutKey: item.checkoutKey,
    model: item.model,
    effort: item.effort,
    authority: item.authority,
    sandbox: item.authority.sandbox,
    priority: item.priority,
    status,
    phase: item.phase ?? status,
    externalEffect: item.externalEffect,
    retryOf: item.retryOf,
    reconciliationRef: item.reconciliationRef,
    threadId: item.threadId,
    turnId: item.turnId,
    lastMessage: item.lastMessage ?? null,
    exitReason: item.exitReason ?? null,
    enqueuedAt: item.enqueuedAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt
  });
}

function hydratePersistedRecord(record, sequence, clock) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Persisted scheduler records must be objects.");
  }
  const authority = normalizeAuthority(record.authority);
  const validated = createLane({
    ...record,
    authority,
    createdAt: record.enqueuedAt ?? record.createdAt
  });
  const originalStatus = record.status;
  const status = TERMINAL_STATUSES.has(originalStatus)
    ? originalStatus
    : hasExternalEffect(authority) ? "outcome_unknown" : "failed";
  return {
    id: validated.id,
    role: validated.role,
    label: validated.label,
    workspaceKey: validated.workspaceKey,
    checkoutKey: boundedIdentifier(
      record.checkoutKey ?? record.workspaceKey,
      "Persisted lane checkout key"
    ),
    model: validated.model,
    effort: validated.effort,
    authority,
    priority: PRIORITY_ORDER.includes(record.priority) ? record.priority : "normal",
    externalEffect: hasExternalEffect(authority),
    retryOf: record.retryOf ?? null,
    reconciliationRef: record.reconciliationRef ?? null,
    status,
    phase: status,
    sequence,
    enqueuedAt: record.enqueuedAt ?? validated.createdAt,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? new Date(clock.now()).toISOString(),
    threadId: record.threadId ?? null,
    turnId: record.turnId ?? null,
    lastMessage: record.lastMessage ?? null,
    exitReason: originalStatus === status
      ? record.exitReason ?? null
      : "Previous Fleet supervisor ended before the lane reached a terminal state.",
    resolve: null,
    reject: null
  };
}

export function recoverPersistedRecords(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError("Scheduler initial records must be an array.");
  }
  const clock = { now: options.now ?? Date.now };
  const seen = new Set();
  return Object.freeze(records.map((record, index) => {
    const item = hydratePersistedRecord(record, index + 1, clock);
    if (seen.has(item.id)) {
      throw new Error(`Lane id is already known to the scheduler: ${item.id}.`);
    }
    seen.add(item.id);
    return publicRecord(item);
  }));
}

function sortQueue(left, right) {
  const priorityDifference = PRIORITY_ORDER.indexOf(left.priority)
    - PRIORITY_ORDER.indexOf(right.priority);
  return priorityDifference || left.sequence - right.sequence;
}

class FleetScheduler {
  constructor({ runtime, store, limits, clock, workspacePath, initialRecords }) {
    assertDependency(
      runtime,
      ["startLane", "continueLane", "resumeLane", "inspectLane", "interruptLane"],
      "runtime"
    );
    assertDependency(store, ["write"], "store");
    assertDependency(clock, ["now", "sleep"], "clock");
    this.runtime = runtime;
    this.store = store;
    this.limits = normalizeLimits(limits);
    this.clock = clock;
    this.queue = [];
    this.active = new Map();
    this.history = new Map();
    this.writerCounts = new Map();
    this.nextSequence = 1;
    this.lastStartedAt = null;
    this.drainPromise = null;
    this.workspacePath = workspacePath ?? null;
    this.hydrate(initialRecords ?? []);
  }

  hydrate(records) {
    if (!Array.isArray(records)) {
      throw new TypeError("Scheduler initial records must be an array.");
    }
    for (const record of records) {
      const item = hydratePersistedRecord(record, this.nextSequence, this.clock);
      this.nextSequence += 1;
      this.assertUnique(item.id);
      this.history.set(item.id, item);
    }
  }

  normalizeContract(contract) {
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new TypeError("Scheduled lane contract must be an object.");
    }
    const authority = normalizeAuthority(contract.authority);
    const lane = createLane({ ...contract, authority });
    const checkoutKey = boundedIdentifier(
      contract.checkoutKey ?? contract.workspaceKey,
      "Lane checkout key"
    );
    const priority = contract.priority ?? "normal";
    if (!PRIORITY_ORDER.includes(priority)) {
      throw new TypeError("Lane priority must be high, normal, or low.");
    }
    if (typeof contract.prompt !== "string" || !contract.prompt.trim()) {
      throw new TypeError("Scheduled lanes require a prompt.");
    }

    return {
      contract: { ...contract, authority },
      id: lane.id,
      role: lane.role,
      label: lane.label,
      workspaceKey: lane.workspaceKey,
      checkoutKey,
      model: lane.model,
      effort: lane.effort,
      authority,
      priority,
      externalEffect: hasExternalEffect(authority),
      retryOf: contract.retryOf ?? null,
      reconciliationRef: contract.reconciliationRef ?? null,
      status: "queued",
      phase: "queued",
      sequence: this.nextSequence,
      enqueuedAt: new Date(this.clock.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      threadId: null,
      turnId: null,
      lastMessage: null,
      exitReason: null,
      resolve: null,
      reject: null
    };
  }

  assertUnique(id) {
    if (
      this.queue.some((item) => item.id === id)
      || this.active.has(id)
      || this.history.has(id)
    ) {
      throw new Error(`Lane id is already known to the scheduler: ${id}.`);
    }
  }

  assertRetryReconciled(item) {
    if (!item.retryOf) {
      return;
    }
    const original = this.history.get(item.retryOf);
    if (!original) {
      throw new Error(`Retry source is not in scheduler history: ${item.retryOf}.`);
    }
    if (original.status === "outcome_unknown" && !item.reconciliationRef) {
      throw new Error(
        `Lane ${item.retryOf} has an unknown external outcome; reconciliation evidence is required.`
      );
    }
  }

  async enqueue(contract) {
    const item = this.normalizeContract(contract);
    this.nextSequence += 1;
    this.assertUnique(item.id);
    this.assertRetryReconciled(item);

    const admitted = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    this.queue.push(item);
    void this.persist().then(() => this.drain()).catch((error) => {
      const index = this.queue.indexOf(item);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }
      item.reject(error);
    });
    return admitted;
  }

  writerAvailable(item) {
    return item.authority.sandbox !== "workspace-write"
      || (this.writerCounts.get(item.checkoutKey) ?? 0)
        < this.limits.maxWritersPerCheckout;
  }

  selectNextIndex() {
    const ordered = this.queue
      .map((item, index) => ({ item, index }))
      .sort((left, right) => sortQueue(left.item, right.item));
    const availableSlots = this.limits.maxActive - this.active.size;

    for (const candidate of ordered) {
      if (!this.writerAvailable(candidate.item)) {
        continue;
      }
      if (candidate.item.authority.sandbox !== "workspace-write" && availableSlots === 1) {
        const olderEligibleWriter = ordered.some(({ item }) =>
          item.sequence < candidate.item.sequence
          && item.authority.sandbox === "workspace-write"
          && this.writerAvailable(item)
        );
        if (olderEligibleWriter) {
          continue;
        }
      }
      return candidate.index;
    }
    return -1;
  }

  async stagger() {
    if (this.lastStartedAt === null || this.limits.staggerMs === 0) {
      return;
    }
    const elapsed = this.clock.now() - this.lastStartedAt;
    const remaining = this.limits.staggerMs - elapsed;
    if (remaining > 0) {
      await this.clock.sleep(remaining);
    }
  }

  drain() {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.drainPromise = this.runDrain().finally(() => {
      this.drainPromise = null;
      if (this.active.size < this.limits.maxActive && this.selectNextIndex() !== -1) {
        void this.drain();
      }
    });
    return this.drainPromise;
  }

  async runDrain() {
    while (this.active.size < this.limits.maxActive) {
      const index = this.selectNextIndex();
      if (index === -1) {
        return;
      }
      const [item] = this.queue.splice(index, 1);
      await this.stagger();
      item.status = "starting";
      item.phase = "starting";
      item.startedAt = new Date(this.clock.now()).toISOString();
      this.active.set(item.id, item);
      if (item.authority.sandbox === "workspace-write") {
        this.writerCounts.set(
          item.checkoutKey,
          (this.writerCounts.get(item.checkoutKey) ?? 0) + 1
        );
      }
      try {
        await this.persist();
      } catch (error) {
        this.release(item, "failed");
        try {
          await this.persist();
        } catch {
          // Preserve the original state-store error for the caller.
        }
        item.reject(error);
        continue;
      }

      try {
        const started = await this.runtime.startLane(item.contract);
        item.status = started.status ?? "running";
        item.phase = started.phase ?? item.status;
        item.threadId = started.threadId ?? null;
        item.turnId = started.turnId ?? null;
        this.lastStartedAt = this.clock.now();
        await this.persist();
        item.resolve(publicRecord(item));
      } catch (error) {
        this.release(item, "failed");
        await this.persist();
        item.reject(error);
      }
    }
  }

  release(item, status) {
    this.active.delete(item.id);
    if (item.authority.sandbox === "workspace-write") {
      const remaining = Math.max(0, (this.writerCounts.get(item.checkoutKey) ?? 1) - 1);
      if (remaining === 0) {
        this.writerCounts.delete(item.checkoutKey);
      } else {
        this.writerCounts.set(item.checkoutKey, remaining);
      }
    }
    item.status = status;
    item.phase = status;
    item.finishedAt = new Date(this.clock.now()).toISOString();
    this.history.set(item.id, item);
  }

  async continue(id, message) {
    if (typeof message !== "string" || !message.trim() || message.length > 128 * 1024) {
      throw new TypeError("Follow-up message must contain between 1 and 131072 characters.");
    }
    if (message.includes("\0")) {
      throw new TypeError("Follow-up message cannot contain null bytes.");
    }
    if (!this.workspacePath) {
      throw new Error("Scheduler workspace path is required for a persisted follow-up.");
    }
    const item = this.history.get(id);
    if (!item || item.status !== "complete" || !item.threadId) {
      throw new Error(`Lane ${id} is not a completed resumable lane.`);
    }
    const resumeRecord = { ...item, status: "complete", phase: "complete" };
    const runtimeAlreadyOwnsLane = this.runtime.inspectLane(id) !== null;

    this.history.delete(id);
    item.status = "starting";
    item.phase = "continuing";
    item.finishedAt = null;
    item.startedAt = new Date(this.clock.now()).toISOString();
    this.active.set(id, item);
    if (item.authority.sandbox === "workspace-write") {
      this.writerCounts.set(
        item.checkoutKey,
        (this.writerCounts.get(item.checkoutKey) ?? 0) + 1
      );
    }
    try {
      await this.persist();
    } catch (error) {
      this.active.delete(id);
      if (item.authority.sandbox === "workspace-write") {
        const remaining = Math.max(0, (this.writerCounts.get(item.checkoutKey) ?? 1) - 1);
        if (remaining === 0) this.writerCounts.delete(item.checkoutKey);
        else this.writerCounts.set(item.checkoutKey, remaining);
      }
      Object.assign(item, resumeRecord);
      this.history.set(id, item);
      throw error;
    }

    try {
      const resumed = runtimeAlreadyOwnsLane
        ? await this.runtime.continueLane(id, message)
        : await this.runtime.resumeLane(resumeRecord, this.workspacePath, message);
      item.status = resumed.status ?? "running";
      item.phase = resumed.phase ?? item.status;
      item.threadId = resumed.threadId ?? item.threadId;
      item.turnId = resumed.turnId ?? null;
      item.lastMessage = resumed.lastMessage ?? item.lastMessage;
      item.exitReason = resumed.exitReason ?? null;
      await this.persist();
      return publicRecord(item);
    } catch (error) {
      this.release(item, "failed");
      item.exitReason = error.message;
      await this.persist();
      throw error;
    }
  }

  async cancel(id, expectedIdentity = null) {
    const queuedIndex = this.queue.findIndex((item) => item.id === id);
    if (queuedIndex !== -1) {
      const [item] = this.queue.splice(queuedIndex, 1);
      item.status = "cancelled";
      item.finishedAt = new Date(this.clock.now()).toISOString();
      this.history.set(item.id, item);
      await this.persist();
      item.resolve(publicRecord(item));
      return publicRecord(item);
    }

    const item = this.active.get(id);
    if (!item) {
      throw new Error(`Lane is not queued or active: ${id}.`);
    }
    const current = this.runtime.inspectLane(id);
    if (
      expectedIdentity
      && (
        expectedIdentity.threadId !== item.threadId
        || expectedIdentity.turnId !== item.turnId
      )
    ) {
      throw new Error(`Lane ${id} target identity changed; cancellation was refused.`);
    }
    if (
      !item.threadId
      || !item.turnId
      || current?.threadId !== item.threadId
      || current?.turnId !== item.turnId
    ) {
      throw new Error(`Lane ${id} process/thread ownership could not be proven.`);
    }
    await this.runtime.interruptLane(id);
    await this.reconcile();
    return this.history.has(id)
      ? publicRecord(this.history.get(id))
      : publicRecord(item);
  }

  async reconcile() {
    for (const item of [...this.active.values()]) {
      const current = this.runtime.inspectLane(item.id);
      if (!current) {
        this.release(item, item.externalEffect ? "outcome_unknown" : "failed");
        continue;
      }
      item.turnId = current.turnId ?? item.turnId;
      item.threadId = current.threadId ?? item.threadId;
      item.phase = current.phase ?? item.phase;
      item.lastMessage = current.lastMessage ?? item.lastMessage;
      item.exitReason = current.exitReason ?? item.exitReason;
      if (TERMINAL_STATUSES.has(current.status)) {
        this.release(item, current.status);
      }
    }
    await this.persist();
    await this.drain();
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: 1,
      limits: this.limits,
      queued: Object.freeze(
        this.queue.slice().sort(sortQueue).map((item) => publicRecord(item, "queued"))
      ),
      active: Object.freeze([...this.active.values()].map((item) => publicRecord(item))),
      history: Object.freeze([...this.history.values()].map((item) => publicRecord(item)))
    });
  }

  async persist() {
    await this.store.write(this.snapshot());
  }
}

export function createScheduler(options = {}) {
  return new FleetScheduler({
    runtime: options.runtime,
    store: options.store,
    limits: options.limits,
    clock: options.clock ?? defaultClock(),
    workspacePath: options.workspacePath,
    initialRecords: options.initialRecords
  });
}
