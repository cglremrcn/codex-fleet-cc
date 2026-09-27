import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { normalizeAuthority } from "./authority.mjs";
import { createLane } from "./domain.mjs";
import { normalizeTokenUsage } from "./token-usage.mjs";

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
  "interrupted",
  "outcome_unknown"
]);
const RECOVERABLE_ACTIVE_STATUSES = new Set(["queued", "starting", "running"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function defaultClock() {
  return {
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    })
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

function persistedList(value, maximumItems = 64, maximumLength = 512) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .slice(0, maximumItems)
    .filter((item) => typeof item === "string" && !CONTROL_CHARACTER.test(item))
    .map((item) => item.slice(0, maximumLength)));
}

function persistedVerificationResults(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    if (!["passed", "failed", "skipped", "blocked"].includes(item.status)) return [];
    if (typeof item.check !== "string" || CONTROL_CHARACTER.test(item.check)) return [];
    return [Object.freeze({
      check: item.check.slice(0, 512),
      status: item.status,
      evidence: typeof item.evidence === "string" ? item.evidence.slice(0, 2_000) : null,
      reason: typeof item.reason === "string" ? item.reason.slice(0, 2_000) : null
    })];
  }));
}

function persistedPreflight(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checks = Array.isArray(value.checks)
    ? value.checks.slice(0, 16).flatMap((check) => {
      if (!check || typeof check !== "object" || Array.isArray(check)) return [];
      return [Object.freeze({
        ok: check.ok === true,
        status: typeof check.status === "string" ? check.status.slice(0, 32) : "unknown",
        check: typeof check.check === "string" ? check.check.slice(0, 128) : "unknown",
        details: typeof check.details === "string" ? check.details.slice(0, 2_000) : null,
        reason: typeof check.reason === "string" ? check.reason.slice(0, 2_000) : null,
        modelTurnStarted: check.modelTurnStarted === true
      })];
    })
    : [];
  return Object.freeze({ ok: value.ok === true, checks: Object.freeze(checks) });
}

function persistedControllerRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.kind !== "string" || typeof value.question !== "string") return null;
  return Object.freeze({
    kind: value.kind.slice(0, 64),
    question: value.question.slice(0, 2_000)
  });
}

function defaultObserveWorkspace(workspacePath, checkedAt) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    return Object.freeze({ dirty: null, checkedAt: null });
  }
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: workspacePath,
    shell: false,
    timeout: 2_000,
    maxBuffer: 65_536,
    windowsHide: true,
    encoding: "utf8"
  });
  return Object.freeze({
    dirty: result.status === 0 && result.error === undefined
      ? result.stdout.trim().length > 0
      : null,
    checkedAt
  });
}

function collectWorkspaceObservation(records, options = {}) {
  const needsObservation = records.some((record) => (
    RECOVERABLE_ACTIVE_STATUSES.has(record?.status)
  ));
  if (!needsObservation) {
    const prior = options.workspaceObservation;
    return Object.freeze({
      dirty: typeof prior?.dirty === "boolean" ? prior.dirty : null,
      checkedAt: typeof prior?.checkedAt === "string" ? prior.checkedAt : null
    });
  }
  const checkedAt = new Date(options.clock.now()).toISOString();
  const observed = (options.observeWorkspace ?? defaultObserveWorkspace)(
    options.workspacePath,
    checkedAt
  );
  return Object.freeze({
    dirty: typeof observed?.dirty === "boolean" ? observed.dirty : null,
    checkedAt: typeof observed?.checkedAt === "string" ? observed.checkedAt : checkedAt
  });
}

function persistedOutcomeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({
    code: "invalid_lane_outcome",
    missing: persistedList(value.missing, 32),
    unknown: persistedList(value.unknown, 32),
    invalid: persistedList(value.invalid, 32)
  });
}

function persistedPendingContinuation(value, recovering = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({
    state: recovering ? "outcome_unknown" : "starting",
    requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : null,
    previousStatus: typeof value.previousStatus === "string" ? value.previousStatus : null,
    previousPhase: typeof value.previousPhase === "string" ? value.previousPhase : null,
    previousTurnId: typeof value.previousTurnId === "string" ? value.previousTurnId : null,
    lastProbeAt: typeof value.lastProbeAt === "string" ? value.lastProbeAt : null,
    lastProbeState: typeof value.lastProbeState === "string" ? value.lastProbeState.slice(0, 64) : null
  });
}

function publicRecord(item, status = item.status) {
  return Object.freeze({
    id: item.id,
    role: item.role,
    label: item.label,
    workspaceKey: item.workspaceKey,
    ...(item.groupPath === undefined ? {} : { groupPath: item.groupPath }),
    checkoutKey: item.checkoutKey,
    ...(item.tokenUsage ? { tokenUsage: normalizeTokenUsage(item.tokenUsage) } : {}),
    model: item.model,
    effort: item.effort,
    authority: item.authority,
    sandbox: item.authority.sandbox,
    priority: item.priority,
    status,
    interactive: item.contract?.interactive === true || item.interactive === true,
    pendingRequests: item.pendingRequests ?? 0,
    pendingQuestionCount: item.pendingQuestionCount ?? 0,
    pendingApprovalCount: item.pendingApprovalCount ?? 0,
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
    verificationResults: item.verificationResults ?? Object.freeze([]),
    artifactRefs: item.artifactRefs ?? Object.freeze([]),
    commitRefs: item.commitRefs ?? Object.freeze([]),
    configChanges: item.configChanges ?? Object.freeze([]),
    outcomeDiagnostics: item.outcomeDiagnostics ?? null,
    controllerRequest: item.controllerRequest ?? null,
    stopReason: item.stopReason ?? null,
    automaticContinuations: item.automaticContinuations ?? 0,
    pendingContinuation: item.pendingContinuation ?? null,
    preflight: item.preflight ?? null,
    touchedFiles: item.touchedFiles ?? Object.freeze([]),
    archivedAt: item.archivedAt ?? null,
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
    : RECOVERABLE_ACTIVE_STATUSES.has(originalStatus)
      ? "interrupted"
      : hasExternalEffect(authority) ? "outcome_unknown" : "failed";
  return {
    id: validated.id,
    role: validated.role,
    label: validated.label,
    workspaceKey: validated.workspaceKey,
    ...(validated.groupPath === undefined ? {} : { groupPath: validated.groupPath }),
    checkoutKey: boundedIdentifier(
      record.checkoutKey ?? record.workspaceKey,
      "Persisted lane checkout key"
    ),
    ...(record.tokenUsage ? { tokenUsage: normalizeTokenUsage(record.tokenUsage) } : {}),
    model: validated.model,
    effort: validated.effort,
    interactive: record.interactive === true,
    pendingRequests: 0,
    pendingQuestionCount: 0,
    pendingApprovalCount: 0,
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
    workPerformed: persistedList(record.workPerformed, 32, 8_192),
    evidenceRefs: persistedList(record.evidenceRefs),
    verification: persistedList(record.verification, 32, 8_192),
    verificationResults: persistedVerificationResults(record.verificationResults),
    artifactRefs: persistedList(record.artifactRefs),
    commitRefs: persistedList(record.commitRefs),
    configChanges: persistedList(record.configChanges),
    outcomeDiagnostics: persistedOutcomeDiagnostics(record.outcomeDiagnostics),
    controllerRequest: persistedControllerRequest(record.controllerRequest),
    stopReason: typeof record.stopReason === "string" ? record.stopReason.slice(0, 2_000) : null,
    automaticContinuations: Number.isSafeInteger(record.automaticContinuations)
      ? Math.max(0, record.automaticContinuations)
      : 0,
    pendingContinuation: persistedPendingContinuation(record.pendingContinuation, true),
    preflight: persistedPreflight(record.preflight),
    touchedFiles: persistedList(record.touchedFiles, 128, 512),
    archivedAt: typeof record.archivedAt === "string" ? record.archivedAt : null,
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
  const workspaceObservation = collectWorkspaceObservation(records, {
    clock,
    workspacePath: options.workspacePath,
    workspaceObservation: options.workspaceObservation,
    observeWorkspace: options.observeWorkspace
  });
  options.onWorkspaceObservation?.(workspaceObservation);
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
  constructor({
    runtime,
    store,
    limits,
    clock,
    workspacePath,
    workspaceObservation,
    observeWorkspace,
    initialRecords
  }) {
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
    this.continuationReservations = new Map();
    this.changeWaiters = new Set();
    this.changeVersion = 0;
    this.nextSequence = 1;
    this.lastStartedAt = null;
    this.drainPromise = null;
    this.workspacePath = workspacePath ?? null;
    this.workspaceObservation = collectWorkspaceObservation(initialRecords ?? [], {
      clock,
      workspacePath: this.workspacePath,
      workspaceObservation,
      observeWorkspace
    });
    this.hydrate(initialRecords ?? []);
  }

  notifyChange() {
    this.changeVersion += 1;
    const waiters = [...this.changeWaiters];
    this.changeWaiters.clear();
    for (const resolve of waiters) resolve(this.changeVersion);
  }

  findRecord(id) {
    return this.queue.find((item) => item.id === id)
      ?? this.active.get(id)
      ?? this.history.get(id)
      ?? null;
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
      if (item.pendingContinuation) this.continuationReservations.set(item.id, item);
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
      ...(lane.groupPath === undefined ? {} : { groupPath: lane.groupPath }),
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
      verificationResults: Object.freeze([]),
      artifactRefs: Object.freeze([]),
      commitRefs: Object.freeze([]),
      configChanges: Object.freeze([]),
      outcomeDiagnostics: null,
      controllerRequest: null,
      stopReason: null,
      automaticContinuations: 0,
      pendingContinuation: null,
      preflight: null,
      touchedFiles: Object.freeze([]),
      archivedAt: null,
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
    if (item.retryOf.includes(":")) {
      // Qualified cross-worktree lineage is persisted for auditability. Reconciliation
      // authority belongs to the source workspace's scheduler, not this one.
      return;
    }
    const original = this.history.get(item.retryOf);
    if (!original) {
      throw new Error(`Retry source is not in scheduler history: ${item.retryOf}.`);
    }
    if (["outcome_unknown", "interrupted"].includes(original.status) && !item.reconciliationRef) {
      throw new Error(
        `Lane ${item.retryOf} requires reconciliation evidence before retry.`
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

  writerKey(item) {
    // A supervisor is rooted in one physical workspace. Labels are display metadata,
    // not proof of isolated worktrees; they must not partition the writer lock.
    return this.workspacePath ? path.resolve(this.workspacePath) : item.checkoutKey;
  }

  writerAvailable(item) {
    const reservedWriters = [...this.continuationReservations.values()].filter((reserved) =>
      reserved.authority.sandbox === "workspace-write"
      && this.writerKey(reserved) === this.writerKey(item)
    ).length;
    return item.authority.sandbox !== "workspace-write"
      || (this.writerCounts.get(this.writerKey(item)) ?? 0) + reservedWriters
        < this.limits.maxWritersPerCheckout;
  }

  writerHolders(item) {
    const key = this.writerKey(item);
    const active = [...this.active.values()]
      .filter((candidate) => candidate.authority.sandbox === "workspace-write"
        && this.writerKey(candidate) === key)
      .map((candidate) => candidate.id);
    const reservations = [...this.continuationReservations.values()]
      .filter((candidate) => candidate.authority.sandbox === "workspace-write"
        && this.writerKey(candidate) === key)
      .map((candidate) => candidate.id);
    return Object.freeze({ active: Object.freeze(active), reservations: Object.freeze(reservations) });
  }

  queueBlocker(item) {
    if (item.status !== "queued") return null;
    const queuedForMs = Math.max(0, this.clock.now() - Date.parse(item.enqueuedAt));
    if (item.authority.sandbox === "workspace-write" && !this.writerAvailable(item)) {
      const holders = this.writerHolders(item);
      const reserved = holders.reservations.map((id) => {
        const lane = this.continuationReservations.get(id);
        return Object.freeze({
          laneId: id,
          kind: "continuation-reservation",
          state: lane?.pendingContinuation?.state ?? "unknown",
          since: lane?.pendingContinuation?.requestedAt ?? null
        });
      });
      return Object.freeze({
        kind: reserved.length > 0 ? "writer-reservation" : "active-writer",
        queuedForMs,
        heldBy: Object.freeze([
          ...holders.active.map((laneId) => Object.freeze({ laneId, kind: "active-writer" })),
          ...reserved
        ]),
        message: reserved.length > 0
          ? "Writer admission is blocked by an unresolved continuation reservation. Reconcile the holding lane before retrying or starting another writer in this worktree."
          : "Writer admission is blocked by another active writer in this physical workspace."
      });
    }
    if (this.occupiedSlots() >= this.limits.maxActive) {
      return Object.freeze({
        kind: "active-capacity",
        queuedForMs,
        heldBy: Object.freeze([
          ...[...this.active.keys()].map((laneId) => Object.freeze({ laneId, kind: "active" })),
          ...[...this.continuationReservations.keys()].map((laneId) => Object.freeze({ laneId, kind: "continuation-reservation" }))
        ]),
        message: "Fleet is at active capacity."
      });
    }
    return Object.freeze({
      kind: "scheduler-order",
      queuedForMs,
      heldBy: Object.freeze([]),
      message: "Lane is eligible but waiting for scheduler ordering/staggering."
    });
  }

  queuedRecord(item) {
    return Object.freeze({
      ...publicRecord(item, "queued"),
      queueBlocker: this.queueBlocker(item)
    });
  }

  occupiedSlots() {
    return this.active.size + this.continuationReservations.size;
  }

  selectNextIndex() {
    const ordered = this.queue
      .map((item, index) => ({ item, index }))
      .sort((left, right) => sortQueue(left.item, right.item));
    const availableSlots = this.limits.maxActive - this.occupiedSlots();

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
      if (this.occupiedSlots() < this.limits.maxActive && this.selectNextIndex() !== -1) {
        void this.drain();
      }
    });
    return this.drainPromise;
  }

  async runDrain() {
    while (this.occupiedSlots() < this.limits.maxActive) {
      if (this.selectNextIndex() === -1) return;
      await this.stagger();
      // A continuation or cancellation can change admission eligibility during the stagger.
      if (this.occupiedSlots() >= this.limits.maxActive) return;
      const index = this.selectNextIndex();
      if (index === -1) {
        return;
      }
      const [item] = this.queue.splice(index, 1);
      item.startPending = true;
      item.status = "starting";
      item.phase = "starting";
      item.startedAt = new Date(this.clock.now()).toISOString();
      this.active.set(item.id, item);
      if (item.authority.sandbox === "workspace-write") {
        this.writerCounts.set(
          this.writerKey(item),
          (this.writerCounts.get(this.writerKey(item)) ?? 0) + 1
        );
      }
      try {
        await this.persist();
      } catch (error) {
        item.startPending = false;
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
        item.tokenUsage = normalizeTokenUsage(started.tokenUsage);
        item.exitReason = started.exitReason ?? null;
        item.outcome = started.outcome ?? null;
        item.workPerformed = started.workPerformed ?? Object.freeze([]);
        item.evidenceRefs = started.evidenceRefs ?? Object.freeze([]);
        item.verification = started.verification ?? Object.freeze([]);
        item.verificationResults = started.verificationResults ?? Object.freeze([]);
        item.artifactRefs = started.artifactRefs ?? Object.freeze([]);
        item.commitRefs = started.commitRefs ?? Object.freeze([]);
        item.configChanges = started.configChanges ?? Object.freeze([]);
        item.outcomeDiagnostics = started.outcomeDiagnostics ?? null;
        item.controllerRequest = started.controllerRequest ?? null;
        item.stopReason = started.stopReason ?? null;
        item.automaticContinuations = started.automaticContinuations ?? 0;
        item.preflight = started.preflight ?? null;
        item.touchedFiles = started.touchedFiles ?? item.touchedFiles;
        this.lastStartedAt = this.clock.now();
        item.startPending = false;
        if (TERMINAL_STATUSES.has(item.status)) {
          this.release(item, item.status, item.phase ?? item.status);
        }
        await this.persist();
        item.resolve(publicRecord(item));
      } catch (error) {
        item.startPending = false;
        const current = this.runtime.inspectLane(item.id);
        const acceptanceUnknown = error?.requestAcceptance === "unknown"
          || current?.status === "outcome_unknown";
        if (current) {
          item.threadId = current.threadId ?? item.threadId;
          item.turnId = current.turnId ?? item.turnId;
          item.exitReason = current.exitReason ?? item.exitReason;
          item.controllerRequest = current.controllerRequest ?? item.controllerRequest;
          item.stopReason = current.stopReason ?? item.stopReason;
          item.commitRefs = current.commitRefs ?? item.commitRefs;
          item.configChanges = current.configChanges ?? item.configChanges;
          item.outcomeDiagnostics = current.outcomeDiagnostics ?? item.outcomeDiagnostics;
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
      const remaining = Math.max(0, (this.writerCounts.get(this.writerKey(item)) ?? 1) - 1);
      if (remaining === 0) {
        this.writerCounts.delete(this.writerKey(item));
      } else {
        this.writerCounts.set(this.writerKey(item), remaining);
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
    if (!this.writerAvailable(item)) {
      throw new Error(`Lane ${id} cannot continue while its checkout already has an active writer.`);
    }
    if (this.occupiedSlots() >= this.limits.maxActive) {
      throw new Error(`Lane ${id} cannot continue while the fleet is at active capacity.`);
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
    // Reserve before the first await so admissions and other follow-ups see this dispatch.
    this.continuationReservations.set(id, item);
    try {
      await this.persist();
    } catch (error) {
      item.pendingContinuation = null;
      this.continuationReservations.delete(id);
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
      if (!item.pendingContinuation) this.continuationReservations.delete(id);
      await this.persist();
      throw error;
    }

    this.history.delete(id);
    this.continuationReservations.delete(id);
    item.status = resumed.status ?? "running";
    item.phase = resumed.phase ?? item.status;
    item.finishedAt = null;
    item.startedAt = new Date(this.clock.now()).toISOString();
    item.pendingContinuation = null;
    this.active.set(id, item);
    if (item.authority.sandbox === "workspace-write") {
      this.writerCounts.set(
        this.writerKey(item),
        (this.writerCounts.get(this.writerKey(item)) ?? 0) + 1
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
    item.verificationResults = resumed.verificationResults ?? Object.freeze([]);
    item.artifactRefs = resumed.artifactRefs ?? Object.freeze([]);
    item.commitRefs = resumed.commitRefs ?? Object.freeze([]);
    item.configChanges = resumed.configChanges ?? Object.freeze([]);
    item.outcomeDiagnostics = resumed.outcomeDiagnostics ?? null;
    item.controllerRequest = resumed.controllerRequest ?? null;
    item.stopReason = resumed.stopReason ?? null;
    item.automaticContinuations = resumed.automaticContinuations ?? 0;
    item.preflight = resumed.preflight ?? item.preflight;
    item.touchedFiles = resumed.touchedFiles ?? item.touchedFiles;
    await this.persist();
    return publicRecord(item);
  }

  async reconcileContinuation(id, options = {}) {
    const item = this.history.get(id);
    if (!item?.pendingContinuation || !this.continuationReservations.has(id)) {
      throw new Error(`Lane ${id} has no unresolved continuation reservation.`);
    }
    const pending = item.pendingContinuation;
    const probe = typeof this.runtime.probeContinuation === "function"
      ? await this.runtime.probeContinuation(publicRecord(item))
      : Object.freeze({ state: "unknown" });
    const releaseAsNotStarted = async (reason, evidenceRef = null) => {
      item.pendingContinuation = null;
      this.continuationReservations.delete(id);
      item.status = pending.previousStatus ?? item.status;
      item.phase = pending.previousPhase ?? item.phase;
      item.turnId = pending.previousTurnId ?? item.turnId;
      if (evidenceRef) item.reconciliationRef = evidenceRef;
      item.controllerRequest = null;
      item.stopReason = null;
      item.exitReason = null;
      await this.persist();
      await this.drain();
      return Object.freeze({
        schemaVersion: 1,
        resolved: true,
        resolution: "not-started",
        reason,
        probe,
        lane: publicRecord(item)
      });
    };
    if (probe.state === "not-started") {
      return releaseAsNotStarted("Codex history proves no new turn was created after the failed follow-up dispatch.");
    }
    if (probe.state === "terminal-started") {
      this.continuationReservations.delete(id);
      item.pendingContinuation = null;
      item.status = "outcome_unknown";
      item.phase = "outcome_unknown";
      item.turnId = probe.latestTurnId ?? item.turnId;
      item.finishedAt = new Date(this.clock.now()).toISOString();
      const question = "The continuation did start and is now terminal, but Fleet did not receive a trustworthy structured result. Reconcile the workspace effects before retrying.";
      item.controllerRequest = Object.freeze({ kind: "runtime_blocker", question });
      item.stopReason = question;
      item.exitReason = question;
      await this.persist();
      await this.drain();
      return Object.freeze({
        schemaVersion: 1,
        resolved: true,
        resolution: "terminal-started-outcome-unknown",
        probe,
        lane: publicRecord(item)
      });
    }
    if (probe.state === "started") {
      return Object.freeze({
        schemaVersion: 1,
        resolved: false,
        resolution: "still-running-or-active",
        probe,
        lane: publicRecord(item),
        message: "The continuation appears to have started, so Fleet keeps the writer reservation to avoid concurrent mutation."
      });
    }
    if (options.assumeNotStarted === true) {
      const evidenceRef = boundedIdentifier(options.evidenceRef, "Continuation reconciliation evidence reference");
      return releaseAsNotStarted(
        "Operator supplied explicit evidence that the ambiguous continuation never started.",
        evidenceRef
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      resolved: false,
      resolution: "ambiguous",
      probe,
      lane: publicRecord(item),
      message: "Fleet could not prove whether the continuation started. The writer reservation remains. Supply explicit reconciliation evidence before assuming it did not start."
    });
  }

  async recordReconciliation(id, options = {}) {
    const item = this.history.get(id);
    if (!item) throw new Error(`Lane is not in scheduler history: ${id}.`);
    if (!["outcome_unknown", "interrupted"].includes(item.status)) {
      throw new Error(`Lane ${id} is ${item.status}; only unknown/interrupted outcomes require reconciliation.`);
    }
    const evidenceRef = boundedIdentifier(options.evidenceRef, "Reconciliation evidence reference");
    const outcome = options.outcome ?? "complete";
    if (!["complete", "failed", "cancelled"].includes(outcome)) {
      throw new TypeError("Reconciliation outcome must be complete, failed, or cancelled.");
    }
    item.reconciliationRef = evidenceRef;
    item.status = outcome;
    item.phase = "reconciled";
    item.exitReason = null;
    item.controllerRequest = null;
    item.stopReason = null;
    item.finishedAt = new Date(this.clock.now()).toISOString();
    await this.persist();
    return publicRecord(item);
  }

  async archive(id) {
    const item = this.history.get(id);
    if (!item) throw new Error(`Only terminal lanes can be archived: ${id}.`);
    if (!TERMINAL_STATUSES.has(item.status)) {
      throw new Error(`Lane ${id} is not terminal and cannot be archived.`);
    }
    if (!item.archivedAt) item.archivedAt = new Date(this.clock.now()).toISOString();
    await this.persist();
    return publicRecord(item);
  }

  async waitForEvent(options = {}) {
    const timeoutMs = options.timeoutMs ?? 4 * 60 * 60_000;
    const stallMs = options.stallMs ?? 20 * 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4 * 60 * 60_000) {
      throw new TypeError("Fleet watch timeout must be between 1 and 14400000 ms.");
    }
    if (!Number.isSafeInteger(stallMs) || stallMs < 60_000 || stallMs > 24 * 60 * 60_000) {
      throw new TypeError("Fleet watch stall threshold must be between 60000 and 86400000 ms.");
    }

    await this.reconcile();
    const startedAt = this.clock.now();
    const baseline = this.snapshot();
    const tracked = new Map([
      ...baseline.queued.map((lane) => [lane.id, Object.freeze({
        status: lane.status,
        controller: Boolean(lane.controllerRequest),
        pendingRequests: lane.pendingRequests ?? 0,
        stalled: Math.max(0, startedAt - Date.parse(lane.enqueuedAt)) >= stallMs
      })]),
      ...baseline.active.map((lane) => [lane.id, Object.freeze({
        status: lane.status,
        controller: Boolean(lane.controllerRequest),
        pendingRequests: lane.pendingRequests ?? 0,
        stalled: false
      })])
    ]);
    const reservationBaseline = new Map(
      baseline.continuationReservations.map((item) => [item.laneId, item.state])
    );
    if (tracked.size === 0 && reservationBaseline.size === 0) {
      return Object.freeze({ schemaVersion: 1, changed: false, reason: "no-live-lanes" });
    }

    const eventFor = (snapshot) => {
      const byId = new Map([
        ...snapshot.queued.map((lane) => [lane.id, lane]),
        ...snapshot.active.map((lane) => [lane.id, lane]),
        ...snapshot.history.map((lane) => [lane.id, lane])
      ]);
      for (const [id, before] of tracked) {
        const lane = byId.get(id);
        if (!lane) continue;
        if (!TERMINAL_STATUSES.has(before.status) && TERMINAL_STATUSES.has(lane.status)) {
          return Object.freeze({
            kind: "lane-terminal",
            laneId: id,
            status: lane.status,
            phase: lane.phase,
            touchedFiles: Object.freeze([...(lane.touchedFiles ?? [])].slice(0, 32))
          });
        }
        if (!before.controller && lane.controllerRequest) {
          return Object.freeze({
            kind: "controller-attention",
            laneId: id,
            status: lane.status,
            phase: lane.phase,
            controllerRequest: lane.controllerRequest
          });
        }
        if (before.pendingRequests === 0 && (lane.pendingRequests ?? 0) > 0) {
          return Object.freeze({
            kind: "intervention",
            laneId: id,
            status: lane.status,
            pendingRequests: lane.pendingRequests,
            pendingQuestionCount: lane.pendingQuestionCount ?? 0,
            pendingApprovalCount: lane.pendingApprovalCount ?? 0
          });
        }
        if (lane.status === "queued" && !before.stalled) {
          const queuedForMs = Math.max(0, this.clock.now() - Date.parse(lane.enqueuedAt));
          if (queuedForMs >= stallMs) {
            return Object.freeze({
              kind: "queue-stalled",
              laneId: id,
              status: lane.status,
              queuedForMs,
              queueBlocker: lane.queueBlocker ?? null
            });
          }
        }
      }
      for (const reservation of snapshot.continuationReservations) {
        const previous = reservationBaseline.get(reservation.laneId);
        if (previous && previous !== "outcome_unknown" && reservation.state === "outcome_unknown") {
          return Object.freeze({
            kind: "continuation-unknown",
            laneId: reservation.laneId,
            status: "outcome_unknown",
            requestedAt: reservation.requestedAt
          });
        }
      }
      return null;
    };

    for (;;) {
      await this.reconcile();
      const snapshot = this.snapshot();
      const event = eventFor(snapshot);
      if (event) {
        return Object.freeze({
          schemaVersion: 1,
          changed: true,
          elapsedMs: Math.max(0, this.clock.now() - startedAt),
          event
        });
      }
      const elapsed = Math.max(0, this.clock.now() - startedAt);
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        return Object.freeze({ schemaVersion: 1, changed: false, reason: "timeout", elapsedMs: elapsed });
      }
      let nextStallMs = remaining;
      for (const [id, before] of tracked) {
        if (before.stalled) continue;
        const lane = snapshot.queued.find((candidate) => candidate.id === id);
        if (!lane) continue;
        const untilStall = Date.parse(lane.enqueuedAt) + stallMs - this.clock.now();
        if (Number.isFinite(untilStall) && untilStall > 0) nextStallMs = Math.min(nextStallMs, untilStall);
      }
      let resolveChange;
      const change = new Promise((resolve) => { resolveChange = resolve; });
      this.changeWaiters.add(resolveChange);
      await Promise.race([change, this.clock.sleep(Math.max(1, Math.min(remaining, nextStallMs, 30_000)))]);
      this.changeWaiters.delete(resolveChange);
    }
  }

  async waitForLane(id, options = {}) {
    const timeoutMs = options.timeoutMs ?? 600_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new TypeError("Lane wait timeout must be between 1 and 3600000 ms.");
    }
    const startedAt = this.clock.now();
    for (;;) {
      await this.reconcile();
      const item = this.findRecord(id);
      if (!item) throw new Error(`Lane was not found: ${id}.`);
      if (TERMINAL_STATUSES.has(item.status)) {
        return Object.freeze({
          schemaVersion: 1,
          timedOut: false,
          elapsedMs: Math.max(0, this.clock.now() - startedAt),
          lane: publicRecord(item)
        });
      }
      const elapsed = Math.max(0, this.clock.now() - startedAt);
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        return Object.freeze({
          schemaVersion: 1,
          timedOut: true,
          elapsedMs: elapsed,
          lane: item.status === "queued" ? this.queuedRecord(item) : publicRecord(item)
        });
      }
      let resolveChange;
      const change = new Promise((resolve) => { resolveChange = resolve; });
      this.changeWaiters.add(resolveChange);
      await Promise.race([change, this.clock.sleep(Math.min(remaining, 1_000))]);
      this.changeWaiters.delete(resolveChange);
    }
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
    if (typeof this.runtime.probeContinuation === "function") {
      for (const [id, item] of [...this.continuationReservations.entries()]) {
        const lastProbe = Date.parse(item.pendingContinuation?.lastProbeAt ?? "");
        if (Number.isFinite(lastProbe) && this.clock.now() - lastProbe < 5_000) continue;
        const probe = await this.runtime.probeContinuation(publicRecord(item));
        item.pendingContinuation = Object.freeze({
          ...item.pendingContinuation,
          lastProbeAt: new Date(this.clock.now()).toISOString(),
          lastProbeState: probe.state
        });
        if (probe.state === "not-started") {
          const pending = item.pendingContinuation;
          this.continuationReservations.delete(id);
          item.pendingContinuation = null;
          item.status = pending.previousStatus ?? item.status;
          item.phase = pending.previousPhase ?? item.phase;
          item.turnId = pending.previousTurnId ?? item.turnId;
          item.exitReason = null;
          item.controllerRequest = null;
          item.stopReason = null;
        } else if (probe.state === "terminal-started") {
          this.continuationReservations.delete(id);
          item.pendingContinuation = null;
          item.status = "outcome_unknown";
          item.phase = "outcome_unknown";
          item.turnId = probe.latestTurnId ?? item.turnId;
          item.finishedAt = new Date(this.clock.now()).toISOString();
          const question = "A previously ambiguous continuation did start and is now terminal, but Fleet did not receive a trustworthy result. Reconcile workspace effects before retry.";
          item.exitReason = question;
          item.controllerRequest = Object.freeze({ kind: "runtime_blocker", question });
          item.stopReason = question;
        }
      }
    }
    for (const item of [...this.active.values()]) {
      if (item.startPending) continue;
      const current = this.runtime.inspectLane(item.id);
      if (!current) {
        this.release(item, item.externalEffect ? "outcome_unknown" : "failed");
        continue;
      }
      item.turnId = current.turnId ?? item.turnId;
      item.threadId = current.threadId ?? item.threadId;
      item.phase = current.phase ?? item.phase;
      item.tokenUsage = normalizeTokenUsage(current.tokenUsage) ?? item.tokenUsage;
      item.pendingRequests = current.pendingRequests ?? 0;
      item.pendingQuestionCount = current.pendingQuestionCount ?? 0;
      item.pendingApprovalCount = current.pendingApprovalCount ?? 0;
      item.lastMessage = current.lastMessage ?? item.lastMessage;
      item.exitReason = current.exitReason ?? item.exitReason;
      item.outcome = current.outcome ?? item.outcome;
      item.workPerformed = current.workPerformed ?? item.workPerformed;
      item.evidenceRefs = current.evidenceRefs ?? item.evidenceRefs;
      item.verification = current.verification ?? item.verification;
      item.verificationResults = current.verificationResults ?? item.verificationResults;
      item.artifactRefs = current.artifactRefs ?? item.artifactRefs;
      item.commitRefs = current.commitRefs ?? item.commitRefs;
      item.configChanges = current.configChanges ?? item.configChanges;
      item.outcomeDiagnostics = current.outcomeDiagnostics ?? item.outcomeDiagnostics;
      item.controllerRequest = current.controllerRequest ?? item.controllerRequest;
      item.stopReason = current.stopReason ?? item.stopReason;
      item.automaticContinuations = current.automaticContinuations
        ?? item.automaticContinuations;
      item.preflight = current.preflight ?? item.preflight;
      item.touchedFiles = current.touchedFiles ?? item.touchedFiles;
      if (TERMINAL_STATUSES.has(current.status)) {
        this.release(item, current.status, current.phase ?? current.status);
      }
    }
    // Final usage can arrive after turn/completed. Do not discard late reported totals.
    for (const item of this.history.values()) {
      const usage = normalizeTokenUsage(this.runtime.inspectLane(item.id)?.tokenUsage);
      if (usage) item.tokenUsage = usage;
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
        this.queue.slice().sort(sortQueue).map((item) => this.queuedRecord(item))
      ),
      active: Object.freeze([...this.active.values()].map((item) => publicRecord(item))),
      history: Object.freeze([...this.history.values()].map((item) => publicRecord(item))),
      continuationReservations: Object.freeze(
        [...this.continuationReservations.values()].map((item) => Object.freeze({
          laneId: item.id,
          state: item.pendingContinuation?.state ?? "unknown",
          requestedAt: item.pendingContinuation?.requestedAt ?? null,
          writer: item.authority.sandbox === "workspace-write"
        }))
      ),
      workspaceObservation: this.workspaceObservation
    });
  }

  async persist() {
    const snapshot = this.snapshot();
    const fingerprint = JSON.stringify(snapshot);
    if (!this.pendingStateWrites && this.persistedFingerprint === fingerprint) return;
    this.pendingStateWrites = (this.pendingStateWrites ?? 0) + 1;
    try {
      await this.store.write(snapshot);
      this.persistedFingerprint = fingerprint;
      this.notifyChange();
    } catch (error) {
      // A rejected write must never be treated as a clean durable snapshot.
      this.persistedFingerprint = null;
      throw error;
    } finally {
      this.pendingStateWrites -= 1;
    }
  }
}

export function createScheduler(options = {}) {
  return new FleetScheduler({
    runtime: options.runtime,
    store: options.store,
    limits: options.limits,
    clock: options.clock ?? defaultClock(),
    workspacePath: options.workspacePath,
    workspaceObservation: options.workspaceObservation,
    observeWorkspace: options.observeWorkspace,
    initialRecords: options.initialRecords
  });
}
