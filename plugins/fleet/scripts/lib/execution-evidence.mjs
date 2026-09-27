import { sanitizeLaneForPersistence } from "./redaction.mjs";
import { ControlError, digest } from "./control-contract.mjs";

const HASH = /^[a-f0-9]{64}$/u;
export const isDigest = (value) => typeof value === "string" && HASH.test(value);
export const allLanes = (snapshot) => Array.isArray(snapshot?.lanes) ? snapshot.lanes
  : [...(snapshot?.queued ?? []), ...(snapshot?.active ?? []), ...(snapshot?.history ?? [])];

/** Authority, not labels, determines whether a lane can affect the observation. */
export function isMutableLane(lane) {
  const authority = lane?.authority ?? {};
  return authority.sandbox === "workspace-write" || authority.browser?.mutate === true
    || authority.database?.write === true || authority.image?.generate === true
    || authority.image?.edit === true || Object.values(authority.externalEffects ?? {}).some((grant) => grant === true);
}

export function sourceHolders(snapshot) {
  return allLanes(snapshot).filter((lane) => isMutableLane(lane) && (
    ["queued", "starting", "running", "interrupted", "outcome_unknown"].includes(lane.status)
    || lane.pendingContinuation
  )).map((lane) => lane.id);
}

export function assertSourceQuiet(snapshot) {
  if (sourceHolders(snapshot).length || (snapshot?.continuationReservations ?? []).some((r) => r.writer)) {
    throw new ControlError("SOURCE_BUSY", "Source evidence requires a quiet workspace. Finish or reconcile mutable work, including queued and uncertain attempts, first.");
  }
}

/** Only the digest persists: never write a prompt/shared context into the ledger. */
export function admissionContractDigest(contract) {
  const fields = ["id", "role", "label", "model", "effort", "prompt", "sharedContext", "authority", "workspaceKey",
    "checkoutKey", "priority", "retryOf", "reconciliationRef", "verificationPlan", "verificationCheckpoint", "ephemeral", "interactive"];
  return digest(Object.fromEntries(fields.map((key) => [key, contract[key] ?? null])), "fleet-admission-contract-v1");
}

export function executionBinding(lane) {
  if (!lane || !isDigest(lane.contractDigest) || typeof lane.admissionId !== "string"
    || typeof lane.threadId !== "string" || !lane.threadId || typeof lane.turnId !== "string" || !lane.turnId
    || !Number.isSafeInteger(lane.executionRevision) || lane.executionRevision < 0) {
    throw new ControlError("EVIDENCE_PROVENANCE_MISSING", "This lane has no complete contract/attempt provenance. Use a newly admitted lane, not a reconstructed legacy verdict.");
  }
  if (!["complete", "verified"].includes(lane.status) || lane.pendingContinuation || lane.archivedAt) {
    throw new ControlError("EVIDENCE_LANE_NOT_COMPLETE", "Evidence requires an unarchived completed lane without a pending continuation.");
  }
  // Canonicalize exactly the bounded public evidence represented after restart.
  // Persistence redacts sensitive text and hydration fills optional nulls; neither
  // is a new execution result. Never bind prompts or private transcript fields.
  const safe = sanitizeLaneForPersistence(lane);
  const strings = (value, count, length) => (Array.isArray(value) ? value : []).slice(0, count)
    .filter((item) => typeof item === "string" && !/[\u0000-\u001f\u007f]/u.test(item)).map((item) => item.slice(0, length));
  const checks = (safe.verificationResults ?? []).slice(0, 32).filter((item) => item && typeof item.check === "string"
    && !/[\u0000-\u001f\u007f]/u.test(item.check) && ["passed", "failed", "skipped", "blocked"].includes(item.status))
    .map((item) => ({ check: item.check.slice(0, 512), status: item.status,
      evidence: typeof item.evidence === "string" ? item.evidence.slice(0, 2000) : null,
      reason: typeof item.reason === "string" ? item.reason.slice(0, 2000) : null }));
  return Object.freeze({ laneId: lane.id, admissionId: lane.admissionId, contractDigest: lane.contractDigest,
    executionRevision: lane.executionRevision, instructionDigest: isDigest(lane.instructionDigest) ? lane.instructionDigest : lane.contractDigest, threadId: lane.threadId, turnId: lane.turnId,
    resultDigest: digest({ outcome: safe.outcome ?? null, workPerformed: strings(safe.workPerformed, 32, 8192),
      verificationResults: checks, evidenceRefs: strings(safe.evidenceRefs, 64, 512),
      artifactRefs: strings(safe.artifactRefs, 64, 512), controllerRequest: safe.controllerRequest ?? null }, "fleet-result-binding-v1") });
}

export function assertBoundVerifier(contract) {
  if (contract.verificationCheckpoint === undefined || contract.verificationCheckpoint === null) return;
  if (!isDigest(contract.verificationCheckpoint) || contract.role !== "independent-verifier"
    || isMutableLane(contract) || contract.authority?.sandbox !== "read-only"
    || contract.authority?.network !== "off" || contract.interactive === true) {
    throw new ControlError("VERIFIER_AUTHORITY_INVALID", "A checkpoint-bound verifier must be a non-interactive, network-off, read-only independent-verifier without mutable capabilities.");
  }
}
