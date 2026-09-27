import path from "node:path";
import { ControlError, digest, validateControlOperation } from "./control-contract.mjs";
import { readPrivateRecord, withPrivateRecordLock, writePrivateRecord } from "./private-record.mjs";
import { allLanes, assertBoundVerifier, assertSourceQuiet, executionBinding, isDigest } from "./execution-evidence.mjs";
import { captureSource, hashWorkspaceFile, safeRelativeFile } from "./source-fingerprint.mjs";

const MAX_RECORDS = 64;
const MAX_BYTES = 512 * 1024;
const same = (a, b) => digest(a) === digest(b);
const recordDomain = (kind) => `fleet-${kind}-v1`;
const findLane = (snapshot, id) => allLanes(snapshot).find((lane) => lane.id === id);

/** Content-bound LOCAL evidence, not a signature, remote attestation or proof of test adequacy. */
export function createEvidenceLedger({ workspacePath, workspaceKey, stateRoot, snapshot, transaction = (fn) => fn(), capture = captureSource, now = Date.now }) {
  const file = path.join(stateRoot, "evidence-ledger.json");
  const empty = () => ({ schemaVersion: 1, workspaceKey, checkpoints: [], receipts: [] });
  async function load() {
    const state = await readPrivateRecord(file, { missing: null, maxBytes: MAX_BYTES });
    if (state === null) return empty();
    if (state.schemaVersion !== 1 || state.workspaceKey !== workspaceKey) throw new ControlError("EVIDENCE_LEDGER_INVALID", "Evidence ledger version or workspace identity is invalid.");
    for (const kind of ["checkpoints", "receipts"]) {
      if (!Array.isArray(state[kind]) || state[kind].length > MAX_RECORDS) throw new ControlError("EVIDENCE_LEDGER_INVALID", "Evidence ledger exceeds its record bounds.");
      const ids = new Set();
      for (const entry of state[kind]) {
        if (!entry || !isDigest(entry.id) || !entry.payload || entry.payload.workspaceKey !== workspaceKey
          || !Number.isSafeInteger(entry.createdAt) || ids.has(entry.id)
          || digest(entry.payload, recordDomain(kind)) !== entry.id) throw new ControlError("EVIDENCE_LEDGER_INVALID", "Evidence record integrity or identity is invalid.");
        ids.add(entry.id);
      }
    }
    return state;
  }
  async function get(kind, id) {
    if (!isDigest(id)) throw new ControlError("EVIDENCE_RECORD_INVALID", "Evidence ID must be a SHA-256 digest.");
    const record = (await load())[kind].find((entry) => entry.id === id);
    if (!record) throw new ControlError("EVIDENCE_RECORD_UNAVAILABLE", "The evidence record is missing or evicted. Capture and verify current evidence again.");
    return record;
  }
  async function put(kind, payload) {
    const id = digest(payload, recordDomain(kind));
    return withPrivateRecordLock(file, async () => {
      const state = await load(), existing = state[kind].find((entry) => entry.id === id);
      if (existing) return existing;
      const record = { id, createdAt: now(), payload };
      state[kind] = [...state[kind].slice(-(MAX_RECORDS - 1)), record];
      await writePrivateRecord(file, state, { maxBytes: MAX_BYTES });
      return record;
    });
  }
  async function currentContext() {
    const current = await snapshot(); assertSourceQuiet(current);
    return { snapshot: current, source: await capture(workspacePath) };
  }
  function assertWorker(checkpoint, current) {
    const binding = executionBinding(findLane(current, checkpoint.payload.worker.laneId));
    if (!same(binding, checkpoint.payload.worker)) throw new ControlError("EVIDENCE_ATTEMPT_CHANGED", "The worker admission, turn, instructions or result no longer match the checkpoint.");
  }
  function assertVerifierResult(checkpoint, verifier) {
    if (!verifier) throw new ControlError("EVIDENCE_VERIFIER_INVALID", "The verifier record is unavailable.");
    assertBoundVerifier(verifier);
    if (verifier?.verificationCheckpoint !== checkpoint.id || verifier.id === checkpoint.payload.worker.laneId
      || Date.parse(verifier.admittedAt ?? "") < checkpoint.createdAt || !Number.isFinite(Date.parse(verifier.admittedAt ?? ""))
      || verifier.outcome !== "accomplished" || verifier.controllerRequest) {
      throw new ControlError("EVIDENCE_VERIFIER_INVALID", "Use a fresh, completed independent verifier admitted for this exact checkpoint.");
    }
    const results = verifier.verificationResults ?? [];
    if (results.some((check) => ["failed", "blocked"].includes(check.status))) throw new ControlError("EVIDENCE_CHECKS_NOT_PASSED", "The verifier reports failed or blocked checks.");
    for (const required of checkpoint.payload.requiredChecks) {
      const reports = results.filter((check) => check.check === required);
      if (reports.length !== 1 || reports[0].status !== "passed") throw new ControlError("EVIDENCE_CHECKS_NOT_PASSED", "Every required check must have one explicit passed result. Missing, skipped or conflicting reports do not pass.");
    }
    return executionBinding(verifier);
  }
  async function verifyReceipt(receiptId, context = null) {
    const receipt = await get("receipts", receiptId), checkpoint = await get("checkpoints", receipt.payload.checkpointId);
    const current = context ?? await currentContext();
    const result = (currentValue, reason) => ({ schemaVersion: 1, receiptId, checkpointId: checkpoint.id,
      laneId: checkpoint.payload.worker.laneId, current: currentValue, reason,
      claim: "source-bound-reported-verification", sourceDigest: checkpoint.payload.source.digest,
      checkedAt: new Date(now()).toISOString(), releaseAuthorized: false });
    if (!same(current.source, checkpoint.payload.source)) return result(false, "source-changed");
    try { assertWorker(checkpoint, current.snapshot); }
    catch (error) { if (!(error instanceof ControlError)) throw error; return result(false, "worker-attempt-changed"); }
    try {
      const verifier = findLane(current.snapshot, receipt.payload.verifier.laneId);
      if (!same(assertVerifierResult(checkpoint, verifier), receipt.payload.verifier)) return result(false, "verifier-attempt-changed");
      for (const artifact of receipt.payload.artifacts) {
        const currentFile = await hashWorkspaceFile(workspacePath, artifact.path);
        if (currentFile.sha256 !== artifact.sha256 || currentFile.bytes !== artifact.bytes) return result(false, "evidence-file-changed");
      }
    } catch (error) {
      if (error instanceof ControlError || error.code === "ENOENT") return result(false, "verifier-or-evidence-unavailable");
      throw error;
    }
    return result(true, "current");
  }
  return Object.freeze({
    async checkpoint(params) {
      validateControlOperation("checkpoint", params);
      return transaction(async () => {
        const current = await currentContext(), worker = executionBinding(findLane(current.snapshot, params.laneId));
        const requiredChecks = [...params.requiredChecks].sort();
        const record = await put("checkpoints", { workspaceKey, worker, source: current.source, requiredChecks });
        // Re-read identity after hashing/persistence; never accept a changed attempt.
        assertWorker(record, await snapshot());
        return { schemaVersion: 1, checkpointId: record.id, laneId: params.laneId, source: current.source,
          verifierBinding: { verificationCheckpoint: record.id, verificationPlan: { completion: requiredChecks } },
          claim: "source-checkpoint", next: "Admit a new read-only independent-verifier with this binding; then attest its evidence." };
      });
    },
    async validateVerifier(contract, currentSnapshot) {
      if (!contract.verificationCheckpoint) return;
      assertBoundVerifier(contract);
      const checkpoint = await get("checkpoints", contract.verificationCheckpoint);
      assertSourceQuiet(currentSnapshot);
      assertWorker(checkpoint, currentSnapshot);
      const checks = contract.verificationPlan?.completion ?? [];
      if (!same([...checks].sort(), checkpoint.payload.requiredChecks)) throw new ControlError("VERIFIER_CHECKS_MISMATCH", "Verifier completion checks must exactly match the checkpoint's requiredChecks.");
      if (!same(await capture(workspacePath), checkpoint.payload.source)) throw new ControlError("VERIFIER_SOURCE_CHANGED", "Source changed before the verifier could start. Capture a current checkpoint; no verifier model turn was started.");
    },
    async attest(params) {
      validateControlOperation("attest", params);
      return transaction(async () => {
        const checkpoint = await get("checkpoints", params.checkpointId), current = await currentContext();
        assertWorker(checkpoint, current.snapshot);
        if (!same(current.source, checkpoint.payload.source)) throw new ControlError("EVIDENCE_SOURCE_CHANGED", "The source no longer matches this checkpoint.");
        const verifierRecord = findLane(current.snapshot, params.verifierLaneId);
        const verifier = assertVerifierResult(checkpoint, verifierRecord);
        const required = checkpoint.payload.requiredChecks;
        if (params.evidenceFiles.length !== required.length || new Set(params.evidenceFiles.map((entry) => entry.check)).size !== required.length
          || params.evidenceFiles.some((entry) => !required.includes(entry.check))) throw new ControlError("EVIDENCE_CHECKS_MISMATCH", "Provide exactly one bounded evidence file for each required check.");
        const artifacts = [];
        for (const entry of [...params.evidenceFiles].sort((a, b) => a.check.localeCompare(b.check))) {
          const report = verifierRecord.verificationResults.find((check) => check.check === entry.check);
          if (report.evidence !== entry.path) throw new ControlError("EVIDENCE_REFERENCE_MISMATCH", "Each evidence file must be the exact workspace-relative path reported for that verifier check.");
          const hashed = await hashWorkspaceFile(workspacePath, safeRelativeFile(entry.path));
          artifacts.push({ check: entry.check, path: entry.path, sha256: hashed.sha256, bytes: hashed.bytes });
        }
        // Evidence collection may itself have modified a non-ignored file. Detect it.
        if (!same(await capture(workspacePath), checkpoint.payload.source)) throw new ControlError("EVIDENCE_SOURCE_CHANGED", "Source changed while collecting verification evidence.");
        const last = await snapshot(); assertSourceQuiet(last); assertWorker(checkpoint, last);
        if (!same(assertVerifierResult(checkpoint, findLane(last, params.verifierLaneId)), verifier)) throw new ControlError("EVIDENCE_ATTEMPT_CHANGED", "Verifier changed during evidence collection.");
        const receipt = await put("receipts", { workspaceKey, checkpointId: checkpoint.id, verifier, artifacts,
          claim: "source-bound-reported-verification" });
        return { schemaVersion: 1, receiptId: receipt.id, checkpointId: checkpoint.id, laneId: checkpoint.payload.worker.laneId,
          claim: receipt.payload.claim, releaseAuthorized: false, next: "check" };
      });
    },
    async check(params) {
      validateControlOperation("check", params);
      return transaction(() => verifyReceipt(params.receiptId));
    },
    async forLane(laneId) {
      const state = await load();
      const checkpoints = new Set(state.checkpoints.filter((entry) => entry.payload.worker.laneId === laneId).map((entry) => entry.id));
      return state.receipts.filter((entry) => checkpoints.has(entry.payload.checkpointId)).slice(-8).map((entry) => ({
        receiptId: entry.id, checkpointId: entry.payload.checkpointId, createdAt: new Date(entry.createdAt).toISOString(),
        claim: entry.payload.claim, currentSourceChecked: false, next: "check"
      }));
    },
    // Internal planner surface; its caller owns the source transaction.
    verifyReceipt, currentContext,
    async stats() { const state = await load(); return { checkpoints: state.checkpoints.length, receipts: state.receipts.length }; }
  });
}
