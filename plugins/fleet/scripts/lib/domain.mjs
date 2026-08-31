export const LANE_STATUSES = Object.freeze([
  "queued",
  "running",
  "complete",
  "verified",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
  "outcome_unknown"
]);

export const TERMINAL_STATUSES = Object.freeze([
  "complete",
  "verified",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
  "outcome_unknown"
]);

const LANE_STATUS_SET = new Set(LANE_STATUSES);
const TERMINAL_STATUS_SET = new Set(TERMINAL_STATUSES);
export const LANE_ROLES = Object.freeze([
  "investigator",
  "current-web-researcher",
  "planner",
  "implementer",
  "browser-qa-operator",
  "visual-analyst",
  "integrator",
  "independent-verifier"
]);
const LANE_ROLE_SET = new Set(LANE_ROLES);

const TRANSITIONS = Object.freeze({
  queued: new Set(["running", "blocked", "failed", "cancelled", "interrupted"]),
  running: new Set(["complete", "blocked", "failed", "cancelled", "interrupted", "outcome_unknown"]),
  complete: new Set(["verified"]),
  verified: new Set(),
  blocked: new Set(["queued", "failed", "cancelled"]),
  failed: new Set(["queued", "cancelled"]),
  cancelled: new Set(),
  interrupted: new Set(["complete", "failed", "cancelled", "outcome_unknown"]),
  outcome_unknown: new Set(["queued", "complete", "failed", "cancelled"])
});

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
export const LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKSPACE_KEY = /^[a-f0-9]{32}$/;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertBoundedText(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must contain between 1 and ${maximum} characters.`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new TypeError(`${label} cannot contain control characters.`);
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp.`);
  }
}

function cloneData(value) {
  if (Array.isArray(value)) {
    return value.map(cloneData);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneData(item)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

function requireReference(value, label) {
  assertBoundedText(value, label, 512);
  return value;
}

function requireEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError("Verification evidence must include between 1 and 32 references.");
  }
  return value.map((reference) => requireReference(reference, "Verification evidence reference"));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUS_SET.has(status);
}

export function createLane(input) {
  assertPlainObject(input, "Lane contract");

  if (!LANE_ID_PATTERN.test(input.id ?? "")) {
    throw new TypeError("Lane id must be 1-64 URL-safe characters.");
  }
  if (!LANE_ROLE_SET.has(input.role)) {
    throw new TypeError(`Unknown lane role: ${String(input.role)}.`);
  }
  assertBoundedText(input.label, "Lane label", 120);
  if (!WORKSPACE_KEY.test(input.workspaceKey ?? "")) {
    throw new TypeError("Workspace key must be a 32-character lowercase hexadecimal digest.");
  }
  assertBoundedText(input.model, "Lane model", 80);
  assertBoundedText(input.effort, "Lane effort", 32);
  assertPlainObject(input.authority, "Lane authority");

  const createdAt = input.createdAt ?? new Date().toISOString();
  assertTimestamp(createdAt, "Lane creation time");

  return deepFreeze({
    schemaVersion: 1,
    id: input.id,
    role: input.role,
    label: input.label,
    workspaceKey: input.workspaceKey,
    model: input.model,
    effort: input.effort,
    authority: cloneData(input.authority),
    status: "queued",
    phase: "queued",
    createdAt,
    updatedAt: createdAt,
    resultRef: null,
    verifierLaneId: null,
    evidenceRefs: [],
    reconciliationRef: null,
    externalEffect: false
  });
}

export function transitionLane(lane, nextStatus, evidence = {}) {
  assertPlainObject(lane, "Lane");
  assertPlainObject(evidence, "Transition evidence");

  if (!LANE_STATUS_SET.has(nextStatus)) {
    throw new TypeError(`Unknown lane status: ${String(nextStatus)}.`);
  }
  if (!TRANSITIONS[lane.status]?.has(nextStatus)) {
    throw new Error(`Lane transition ${String(lane.status)} -> ${nextStatus} is not allowed.`);
  }

  assertTimestamp(evidence.at, "Transition time");
  const next = {
    ...cloneData(lane),
    status: nextStatus,
    phase: nextStatus,
    updatedAt: evidence.at
  };

  if (nextStatus === "complete") {
    next.resultRef = requireReference(evidence.resultRef, "Result reference");
  }

  if (nextStatus === "verified") {
    if (!evidence.verifierLaneId || !Array.isArray(evidence.evidenceRefs)) {
      throw new TypeError(
        "Verification evidence requires an independent verifier lane and evidence references."
      );
    }
    assertBoundedText(evidence.verifierLaneId, "Verifier lane id", 64);
    if (evidence.verifierLaneId === lane.id) {
      throw new Error("Verification requires an independent verifier lane.");
    }
    next.verifierLaneId = evidence.verifierLaneId;
    next.evidenceRefs = requireEvidenceRefs(evidence.evidenceRefs);
  }

  if (nextStatus === "outcome_unknown") {
    if (evidence.externalEffect !== true) {
      throw new Error("Unknown outcomes require an explicit external effect marker.");
    }
    next.externalEffect = true;
  }

  if (lane.status === "outcome_unknown" && nextStatus === "queued") {
    next.reconciliationRef = requireReference(
      evidence.reconciliationRef,
      "Reconciliation reference"
    );
  }

  return deepFreeze(next);
}
