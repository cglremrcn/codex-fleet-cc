import crypto from "node:crypto";

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
  return authority.browser.mutate
    || authority.database.write
    || authority.image.generate
    || authority.image.edit
    || Object.values(authority.externalEffects).some(Boolean);
}

function assertLaneMessage(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 128 * 1024) {
    throw new TypeError("Lane message must contain between 1 and 131072 characters.");
  }
  if (message.includes("\0")) {
    throw new TypeError("Lane message cannot contain null bytes.");
  }
  return message;
}

function persistedList(value, maximumItems = 64) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .slice(0, maximumItems)
    .filter((item) => typeof item === "string" && !CONTROL_CHARACTER.test(item))
    .map((item) => item.slice(0, 512)));
}

function persistedControllerRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.kind !== "string" || typeof value.question !== "string") return null;
  return Object.freeze({
    kind: value.kind.slice(0, 64),
    question: value.question.slice(0, 2_000)
  });
}

function persistedPendingContinuation(value, recovering = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({
    state: recovering ? "outcome_unknown" : "starting",
    requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : null,
    previousStatus: typeof value.previousStatus === "string" ? value.previousStatus : null,
    previousPhase: typeof value.previousPhase === "string" ? value.previousPhase : null,
    previousTurnId: typeof value.previousTurnId === "string" ? value.previousTurnId : null
  });
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
    admissionId: item.admissionId,
    admissionSource: item.admissionSource,
    admittedAt: item.admittedAt,
    threadId: item.threadId,
    turnId: item.turnId,
    lastMessage: item.lastMessage ?? null,
    exitReason: item.exitReason ?? null,
    outcome: item.outcome ?? null,
    workPerformed: item.workPerformed ?? Object.freeze([]),
    evidenceRefs: item.evidenceRefs ?? Object.freeze([]),
    verification: item.verification ?? Object.freeze([]),
    artifactRefs: item.artifactRefs ?? Object.freeze([]),
    controllerRequest: item.controllerRequest ?? null,
    stopReason: item.stopReason ?? null,
    automaticContinuations: item.automaticContinuations ?? 0,
    pendingContinuation: item.pendingContinuation ?? null,
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
    admissionId: boundedIdentifier(
      record.admissionId ?? crypto.randomUUID(),
      "Persisted lane admission id"
    ),
    admissionSource: boundedIdentifier(
      record.admissionSource ?? "legacy-state",
      "Persisted lane admission source"
    ),
    admittedAt: record.admittedAt ?? record.enqueuedAt ?? validated.createdAt,
    status,
    phase: originalStatus === status && typeof record.phase === "string"
      ? record.phase.slice(0, 128)
      : status,
    sequence,
    enqueuedAt: record.enqueuedAt ?? validated.createdAt,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? new Date(clock.now()).toISOString(),
    threadId: record.threadId ?? null,
    turnId: record.turnId ?? null,
    lastMessage: record.lastMessage ?? null,
    outcome: record.outcome ?? null,
    workPerformed: persistedList(record.workPerformed, 32),
    evidenceRefs: persistedList(record.evidenceRefs),
    verification: persistedList(record.verification, 32),
    artifactRefs: persistedList(record.artifactRefs),
    controllerRequest: persistedControllerRequest(record.controllerRequest),
    stopReason: typeof record.stopReason === "string" ? record.stopReason.slice(0, 2_000) : null,
    automaticContinuations: Number.isSafeInteger(record.automaticContinuations)
      ? Math.max(0, record.automaticContinuations)
      : 0,
    pendingContinuation: persistedPendingContinuation(record.pendingContinuation, true),
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

    const enqueuedAt = new Date(this.clock.now()).toISOString();
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
      admissionId: boundedIdentifier(
        contract.admissionId ?? crypto.randomUUID(),
        "Lane admission id"
      ),
      admissionSource: boundedIdentifier(
        contract.admissionSource ?? "scheduler-direct",
        "Lane admission source"
      ),
      admittedAt: enqueuedAt,
      status: "queued",
      phase: "queued",
      sequence: this.nextSequence,
      enqueuedAt,
      startedAt: null,
      finishedAt: null,
      threadId: null,
      turnId: null,
      lastMessage: null,
      exitReason: null,
      outcome: null,
      workPerformed: Object.freeze([]),
      evidenceRefs: Object.freeze([]),
      verification: Object.freeze([]),
      artifactRefs: Object.freeze([]),
      controllerRequest: null,
      stopReason: null,
      automaticContinuations: 0,
      pendingContinuation: null,
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

  assertAvailable(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new TypeError("Lane availability check requires at least one lane ID.");
    }
    const incoming = new Set();
    for (const id of ids) {
      boundedIdentifier(id, "Lane id");
      if (incoming.has(id)) throw new Error(`Lane id is duplicated in this admission: ${id}.`);
      incoming.add(id);
      this.assertUnique(id);
    }
    return true;
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
        item.lastMessage = started.lastMessage ?? null;
        item.exitReason = started.exitReason ?? null;
        item.outcome = started.outcome ?? null;
        item.workPerformed = started.workPerformed ?? Object.freeze([]);
        item.evidenceRefs = started.evidenceRefs ?? Object.freeze([]);
        item.verification = started.verification ?? Object.freeze([]);
        item.artifactRefs = started.artifactRefs ?? Object.freeze([]);
        item.controllerRequest = started.controllerRequest ?? null;
        item.stopReason = started.stopReason ?? null;
        item.automaticContinuations = started.automaticContinuations ?? 0;
        this.lastStartedAt = this.clock.now();
        await this.persist();
        item.resolve(publicRecord(item));
      } catch (error) {
        const current = this.runtime.inspectLane(item.id);
        const acceptanceUnknown = error?.requestAcceptance === "unknown"
          || current?.status === "outcome_unknown";
        if (current) {
          item.threadId = current.threadId ?? item.threadId;
          item.turnId = current.turnId ?? item.turnId;
          item.exitReason = current.exitReason ?? item.exitReason;
          item.controllerRequest = current.controllerRequest ?? item.controllerRequest;
          item.stopReason = current.stopReason ?? item.stopReason;
        }
        this.release(
          item,
          acceptanceUnknown ? "outcome_unknown" : "failed",
          acceptanceUnknown ? "outcome_unknown" : "failed"
        );
        await this.persist();
        item.reject(error);
      }
    }
  }

  release(item, status, phase = status) {
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
    item.phase = phase;
    item.finishedAt = new Date(this.clock.now()).toISOString();
    this.history.set(item.id, item);
  }

  async continue(id, message) {
    const validatedMessage = assertLaneMessage(message);
    if (!this.workspacePath) {
      throw new Error("Scheduler workspace path is required for a persisted follow-up.");
    }
    const item = this.history.get(id);
    const resumable = item?.status === "complete"
      || (item?.status === "blocked" && item.phase === "needs-controller");
    if (!item || !resumable || !item.threadId) {
      throw new Error(`Lane ${id} is not a resumable completed or controller-blocked lane.`);
    }
    if (item.pendingContinuation) {
      throw new Error(
        `Lane ${id} has a pending continuation outcome that requires reconciliation.`
      );
    }
    if (
      item.authority.sandbox === "workspace-write"
      && (this.writerCounts.get(item.checkoutKey) ?? 0) >= this.limits.maxWritersPerCheckout
    ) {
      throw new Error(`Lane ${id} cannot continue while its checkout already has an active writer.`);
    }
    const resumeRecord = { ...item };
    const runtimeAlreadyOwnsLane = this.runtime.inspectLane(id) !== null;
    item.pendingContinuation = Object.freeze({
      state: "starting",
      requestedAt: new Date(this.clock.now()).toISOString(),
      previousStatus: item.status,
      previousPhase: item.phase,
      previousTurnId: item.turnId
    });
    try {
      await this.persist();
    } catch (error) {
      item.pendingContinuation = null;
      throw error;
    }

    let resumed;
    try {
      resumed = runtimeAlreadyOwnsLane
        ? await this.runtime.continueLane(id, validatedMessage)
        : await this.runtime.resumeLane(resumeRecord, this.workspacePath, validatedMessage);
    } catch (error) {
      item.pendingContinuation = error?.requestAcceptance === "unknown"
        ? Object.freeze({ ...item.pendingContinuation, state: "outcome_unknown" })
        : null;
      await this.persist();
      throw error;
    }

    this.history.delete(id);
    item.status = resumed.status ?? "running";
    item.phase = resumed.phase ?? item.status;
    item.finishedAt = null;
    item.startedAt = new Date(this.clock.now()).toISOString();
    item.pendingContinuation = null;
    this.active.set(id, item);
    if (item.authority.sandbox === "workspace-write") {
      this.writerCounts.set(
        item.checkoutKey,
        (this.writerCounts.get(item.checkoutKey) ?? 0) + 1
      );
    }
    item.threadId = resumed.threadId ?? item.threadId;
    item.turnId = resumed.turnId ?? null;
    item.lastMessage = resumed.lastMessage ?? item.lastMessage;
    item.exitReason = resumed.exitReason ?? null;
    item.outcome = resumed.outcome ?? null;
    item.workPerformed = resumed.workPerformed ?? Object.freeze([]);
    item.evidenceRefs = resumed.evidenceRefs ?? Object.freeze([]);
    item.verification = resumed.verification ?? Object.freeze([]);
    item.artifactRefs = resumed.artifactRefs ?? Object.freeze([]);
    item.controllerRequest = resumed.controllerRequest ?? null;
    item.stopReason = resumed.stopReason ?? null;
    item.automaticContinuations = resumed.automaticContinuations ?? 0;
    await this.persist();
    return publicRecord(item);
  }

  async message(id, message) {
    const validatedMessage = assertLaneMessage(message);
    const active = this.active.get(id);
    if (active && active.threadId && active.turnId) {
      if (typeof this.runtime.steerLane !== "function") {
        throw new Error("Runtime steering is unavailable.");
      }
      const steered = await this.runtime.steerLane(id, validatedMessage, {
        threadId: active.threadId,
        turnId: active.turnId
      });
      active.threadId = steered.threadId ?? active.threadId;
      active.turnId = steered.turnId ?? active.turnId;
      await this.persist();
      return publicRecord(active);
    }
    return this.continue(id, validatedMessage);
  }

  async readSession(id) {
    const item = this.queue.find((candidate) => candidate.id === id)
      ?? this.active.get(id)
      ?? this.history.get(id);
    if (!item) throw new Error(`Lane session was not found: ${id}.`);
    if (!item.threadId) {
      return Object.freeze({
        schemaVersion: 1,
        laneId: id,
        threadId: null,
        source: "fleet-queue",
        admissionId: item.admissionId,
        admissionSource: item.admissionSource,
        admittedAt: item.admittedAt,
        canAcceptDirectInput: false,
        messages: Object.freeze([])
      });
    }
    if (typeof this.runtime.readThread !== "function") {
      throw new Error("Runtime thread inspection is unavailable.");
    }
    const session = await this.runtime.readThread(item.threadId);
    return Object.freeze({
      ...session,
      laneId: id,
      admissionId: item.admissionId,
      admissionSource: item.admissionSource,
      admittedAt: item.admittedAt
    });
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
      item.outcome = current.outcome ?? item.outcome;
      item.workPerformed = current.workPerformed ?? item.workPerformed;
      item.evidenceRefs = current.evidenceRefs ?? item.evidenceRefs;
      item.verification = current.verification ?? item.verification;
      item.artifactRefs = current.artifactRefs ?? item.artifactRefs;
      item.controllerRequest = current.controllerRequest ?? item.controllerRequest;
      item.stopReason = current.stopReason ?? item.stopReason;
      item.automaticContinuations = current.automaticContinuations
        ?? item.automaticContinuations;
      if (TERMINAL_STATUSES.has(current.status)) {
        this.release(item, current.status, current.phase ?? current.status);
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
