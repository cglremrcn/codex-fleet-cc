import crypto from "node:crypto";
import { CONTROL_VERSION, ControlError, digest, validateControlOperation } from "./control-contract.mjs";
import { normalizeTokenUsage } from "./token-usage.mjs";
import { redactText } from "./redaction.mjs";

const STATUSES = new Set(["queued", "starting", "running", "complete", "verified", "blocked", "failed", "cancelled", "interrupted", "outcome_unknown"]);
const ATTENTION = new Set(["blocked", "failed", "interrupted", "outcome_unknown"]);
const MAX_LANES = 256;
const safe = (value, size) => typeof value === "string" ? redactText(value).slice(0, size).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ") : null;
const count = (value) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, 4096) : 0;

/** Fixed, non-authoritative projection. No prompt, raw output, authority grants or timestamps. */
export function projectControlLane(lane, includeUsage = false) {
  if (!lane || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(lane.id ?? "") || !STATUSES.has(lane.status)) {
    throw new ControlError("OBSERVATION_INVALID", "A lane record is invalid; the observation cannot be treated as empty or healthy.");
  }
  const pending = Math.max(count(lane.pendingRequests), count(lane.pendingApprovalCount) + count(lane.pendingQuestionCount));
  return {
    id: lane.id, admissionId: safe(lane.admissionId, 128), turnId: safe(lane.turnId, 128),
    executionRevision: Number.isSafeInteger(lane.executionRevision) ? lane.executionRevision : null,
    instructionDigest: /^[a-f0-9]{64}$/u.test(lane.instructionDigest ?? "") ? lane.instructionDigest : null,
    status: lane.status, phase: safe(lane.phase, 96), role: safe(lane.role, 64),
    model: safe(lane.model, 80), effort: safe(lane.effort, 32),
    attention: ATTENTION.has(lane.status) || Boolean(lane.controllerRequest) || pending > 0,
    requests: { total: pending, questions: count(lane.pendingQuestionCount), approvals: count(lane.pendingApprovalCount) },
    uncertain: lane.status === "outcome_unknown" || Boolean(lane.pendingContinuation),
    resultDigest: ["complete", "verified", "blocked", "failed", "interrupted", "outcome_unknown"].includes(lane.status)
      ? digest({ status: lane.status, outcome: lane.outcome ?? null, work: lane.workPerformed ?? [],
        checks: lane.verificationResults ?? [], evidence: lane.evidenceRefs ?? [], artifacts: lane.artifactRefs ?? [],
        stopReason: lane.stopReason ?? null, request: lane.controllerRequest ?? null }, "fleet-result-projection-v1") : null,
    queue: lane.queueBlocker ? { kind: safe(lane.queueBlocker.kind, 48), heldBy: (lane.queueBlocker.heldBy ?? []).slice(0, 16).map((item) => safe(item.laneId, 64)) } : null,
    ...(includeUsage ? { reportedUsage: normalizeTokenUsage(lane.tokenUsage) } : {})
  };
}

function snapshotProjection(snapshot, includeUsage) {
  if (!snapshot || typeof snapshot !== "object" || !(Array.isArray(snapshot.lanes)
    || [snapshot.queued, snapshot.active, snapshot.history].every(Array.isArray))) throw new ControlError("OBSERVATION_INVALID", "A complete snapshot shape is required; unavailable data is not an empty fleet.");
  const lanes = snapshot.lanes ?? [...snapshot.queued, ...snapshot.active, ...snapshot.history];
  if (!Array.isArray(lanes) || lanes.length > MAX_LANES) throw new ControlError("OBSERVATION_INVALID", "The observed lane count is invalid or exceeds the retained-state bound.");
  const ids = new Set();
  const projected = lanes.map((lane) => {
    if (ids.has(lane.id)) throw new ControlError("OBSERVATION_INVALID", "Duplicate lane identity in observation.");
    ids.add(lane.id);
    return { ...projectControlLane(lane, includeUsage), archived: Boolean(lane.archivedAt) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const records = projected.filter(lane => !lane.archived).map(({ archived, ...lane }) => lane);
  const hidden = projected.filter(lane => lane.archived);
  return { records, totals: {
    visible: records.length,
    active: records.filter((lane) => ["starting", "running"].includes(lane.status)).length,
    queued: records.filter((lane) => lane.status === "queued").length,
    attention: records.filter((lane) => lane.attention).length,
    awaitingVerification: records.filter((lane) => lane.status === "complete").length,
    unknown: records.filter((lane) => lane.uncertain).length,
    archived: hidden.length,
    archivedAttention: hidden.filter(lane => lane.attention || lane.uncertain).length,
    archivedAttentionIds: hidden.filter(lane => lane.attention || lane.uncertain).map(lane => lane.id).slice(0, 16),
    archivedAttentionTruncated: hidden.filter(lane => lane.attention || lane.uncertain).length > 16
  } };
}

/** Coalesced state, NOT an event log. Epoch/cursor loss requires an explicit reset. */
export function createObservationFeed({ workspaceKey, maxSnapshots = 16, maxBatches = 8, maxRetainedBytes = 2 * 1024 * 1024 } = {}) {
  if (!/^[a-f0-9]{32}$/u.test(workspaceKey ?? "")) throw new TypeError("Observation feed requires a canonical workspace key.");
  if (![maxSnapshots, maxBatches, maxRetainedBytes].every(Number.isSafeInteger) || maxSnapshots < 1 || maxBatches < 1 || maxRetainedBytes < 65536) throw new TypeError("Invalid observation cache bounds.");
  const epoch = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(32);
  const snapshots = new Map(), batches = new Map();
  let retainedBytes = 0;
  const prefix = `v1.${workspaceKey}.${epoch}.`;
  const cursorPattern = /^v1\.([a-f0-9]{32})\.([a-f0-9]{16})\.([01])\.([a-f0-9]{64})$/u;

  function cache(map, key, value, limit) {
    if (map.has(key)) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxRetainedBytes / 2) throw new ControlError("OBSERVATION_TOO_LARGE", "One projection exceeds the observation retention budget. Inspect individual results instead.");
    map.set(key, { value, bytes }); retainedBytes += bytes;
    while (map.size > limit) { const first = map.keys().next().value; retainedBytes -= map.get(first).bytes; map.delete(first); }
    while (retainedBytes > maxRetainedBytes) {
      const victim = snapshots.size > 1 ? snapshots : batches;
      if (!victim.size) break;
      const first = victim.keys().next().value; retainedBytes -= victim.get(first).bytes; victim.delete(first);
    }
  }
  function validateCursor(cursor, includeUsage) {
    const match = cursorPattern.exec(cursor ?? "");
    if (!match || match[1] !== workspaceKey || Number(match[3]) !== Number(includeUsage)) {
      throw new ControlError("OBSERVATION_CURSOR_INVALID", "Cursor belongs to another workspace/projection or has an invalid shape. Start a fresh observation.");
    }
    return match[2] === epoch;
  }
  function pageToken(id, offset) {
    const body = `${id}.${offset}`;
    return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  }
  function decodePage(token) {
    const match = /^([a-f0-9]{32})\.(\d{1,4})\.([a-f0-9]{64})$/u.exec(token);
    if (!match) throw new ControlError("OBSERVATION_PAGE_INVALID", "Malformed continuation page token.");
    const body = `${match[1]}.${match[2]}`;
    const expected = crypto.createHmac("sha256", secret).update(body).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(match[3], "hex"))) throw new ControlError("OBSERVATION_RESET_REQUIRED", "Page token is from another supervisor epoch or was changed; discard partial pages and observe again.");
    return { id: match[1], offset: Number(match[2]) };
  }
  function renderPage(id, offset) {
    const batch = batches.get(id)?.value;
    if (!batch) throw new ControlError("OBSERVATION_RESET_REQUIRED", "The frozen observation batch expired or was evicted; discard partial pages and observe again.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > batch.entries.length) throw new ControlError("OBSERVATION_PAGE_INVALID", "Page offset is outside the frozen observation.");
    const envelope = { schemaVersion: CONTROL_VERSION, kind: "state-observation", workspaceKey, batchId: id,
      mode: batch.mode, resetReason: batch.resetReason, fromCursor: batch.fromCursor,
      totals: batch.totals, changes: [], offset, done: false, cursor: null, nextPage: null };
    // Reserve enough room for final cursor or the authenticated next-page token.
    const reserve = 256;
    let used = Buffer.byteLength(JSON.stringify(envelope)) + reserve;
    let index = offset;
    for (; index < batch.entries.length; index++) {
      const entry = batch.entries[index]; const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (used + size > batch.maxBytes) break;
      envelope.changes.push(entry); used += size;
    }
    if (index === offset && index < batch.entries.length) throw new ControlError("OBSERVATION_PAGE_TOO_SMALL", "One projected record does not fit; repeat the initial observation with a larger maxBytes.");
    envelope.done = index === batch.entries.length;
    envelope.cursor = envelope.done ? batch.toCursor : null;
    envelope.nextPage = envelope.done ? null : pageToken(id, index);
    if (Buffer.byteLength(JSON.stringify(envelope)) > batch.maxBytes) throw new ControlError("OBSERVATION_TOO_LARGE", "Observation envelope exceeded its explicit byte budget.");
    return envelope;
  }
  return Object.freeze({
    observe(snapshot, params = {}) {
      validateControlOperation("observe", params);
      if (params.nextPage) { const page = decodePage(params.nextPage); return renderPage(page.id, page.offset); }
      const includeUsage = params.includeUsage === true;
      const projection = snapshotProjection(snapshot, includeUsage);
      const cursor = `${prefix}${Number(includeUsage)}.${digest(projection, "fleet-observation-v1")}`;
      const sameEpoch = params.cursor ? validateCursor(params.cursor, includeUsage) : true;
      const before = params.cursor && sameEpoch ? snapshots.get(params.cursor)?.value : null;
      cache(snapshots, cursor, projection, maxSnapshots);
      const unchanged = params.cursor === cursor;
      const mode = unchanged || before ? "delta" : "reset";
      const prior = new Map((before?.records ?? []).map((lane) => [lane.id, lane]));
      const entries = unchanged ? [] : projection.records.filter((lane) => !prior.has(lane.id)
        || JSON.stringify(prior.get(lane.id)) !== JSON.stringify(lane)).map((lane) => ({ type: "upsert", lane }));
      if (mode === "delta" && !unchanged) {
        const present = new Set(projection.records.map((lane) => lane.id));
        for (const id of prior.keys()) if (!present.has(id)) entries.push({ type: "remove", id });
      }
      const id = crypto.randomBytes(16).toString("hex");
      cache(batches, id, { mode, fromCursor: mode === "delta" ? params.cursor ?? null : null,
        toCursor: cursor, resetReason: mode === "reset" ? !params.cursor ? "initial" : sameEpoch ? "cursor-evicted" : "supervisor-restarted" : null,
        entries, totals: projection.totals, maxBytes: params.maxBytes ?? 8192 }, maxBatches);
      return renderPage(id, 0);
    },
    compare(snapshot, cursor, includeUsage = false) {
      if (cursor && !validateCursor(cursor, includeUsage)) return { changed: true, reason: "supervisor-restarted" };
      const projection = snapshotProjection(snapshot, includeUsage);
      const current = `${prefix}${Number(includeUsage)}.${digest(projection, "fleet-observation-v1")}`;
      return { changed: cursor !== current, cursor: current,
        reason: cursor !== current ? "state-changed" : "unchanged", totals: projection.totals };
    },
    stats: () => ({ snapshots: snapshots.size, batches: batches.size, retainedBytes }),
    dispose() { snapshots.clear(); batches.clear(); retainedBytes = 0; secret.fill(0); }
  });
}

/** Buffer all pages, then replace state atomically. No page may advance the public cursor early. */
export function createObservationAssembler(previous = { cursor: null, lanes: [] }) {
  let batch = null;
  let complete = null;
  const initial = { cursor: previous.cursor ?? null, lanes: structuredClone(previous.lanes ?? []) };
  return Object.freeze({
    accept(page) {
      if (complete) throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "The observation batch is already complete.");
      if (!page || page.schemaVersion !== 1 || !Array.isArray(page.changes) || !["delta", "reset"].includes(page.mode)
        || !Number.isSafeInteger(page.offset) || typeof page.done !== "boolean") throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Invalid observation page.");
      if (!batch) {
        if (page.offset !== 0 || (page.mode === "delta" && page.fromCursor !== initial.cursor)) throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "The first page is not based on the retained observation.");
        batch = { id: page.batchId, workspaceKey: page.workspaceKey, mode: page.mode, fromCursor: page.fromCursor,
          offset: 0, totals: JSON.stringify(page.totals), lanes: new Map((page.mode === "reset" ? [] : initial.lanes).map((lane) => [lane.id, lane])) };
      }
      if (page.batchId !== batch.id || page.workspaceKey !== batch.workspaceKey || page.mode !== batch.mode || page.fromCursor !== batch.fromCursor
        || page.offset !== batch.offset || JSON.stringify(page.totals) !== batch.totals) throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Mixed, repeated or out-of-order observation pages.");
      for (const change of page.changes) {
        if (change.type === "remove" && typeof change.id === "string") batch.lanes.delete(change.id);
        else if (change.type === "upsert" && change.lane && STATUSES.has(change.lane.status) && typeof change.lane.id === "string") batch.lanes.set(change.lane.id, structuredClone(change.lane));
        else throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Invalid observation change.");
      }
      batch.offset += page.changes.length;
      if (batch.offset > MAX_LANES * 2 || batch.lanes.size > MAX_LANES) throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Observation assembly exceeded retained-state bounds.");
      if (page.done) {
        if (typeof page.cursor !== "string" || page.nextPage !== null || batch.lanes.size !== page.totals.visible) throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Final observation identity or count is invalid.");
        complete = { cursor: page.cursor, lanes: [...batch.lanes.values()], totals: structuredClone(page.totals) };
        return structuredClone(complete);
      }
      if (page.cursor !== null || typeof page.nextPage !== "string" || page.changes.length === 0) throw new ControlError("OBSERVATION_ASSEMBLY_INVALID", "Partial observation must retain its cursor and make progress.");
      return null;
    },
    result: () => complete ? structuredClone(complete) : null
  });
}
