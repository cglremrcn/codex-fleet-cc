import crypto from "node:crypto";
import { redactText } from "./redaction.mjs";

export const INBOX_METHODS = Object.freeze({
  input: "item/tool/requestUserInput",
  command: "item/commandExecution/requestApproval",
  file: "item/fileChange/requestApproval",
  permissions: "item/permissions/requestApproval"
});
const SUPPORTED = new Set(Object.values(INBOX_METHODS));
const OPEN = new Set(["pending", "delegated"]);
const TERMINAL = new Set(["resolved", "expired", "unknown"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = (value) => JSON.parse(JSON.stringify(value));
function fail(message, code = "FLEET_INBOX_INVALID") { const error = new Error(message); error.code = code; throw error; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("Unexpected inbox payload fields.");
}
function text(value, maximum, label, multiline = false) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || (multiline ? CONTROL.test(value.replace(/[\r\n\t]/gu, "")) : CONTROL.test(value))) fail(`Invalid ${label}.`);
  return value;
}
function rpcKey(id) {
  if (Number.isSafeInteger(id)) return `number:${id}`;
  if (typeof id === "string" && id.length && id.length <= 256 && !CONTROL.test(id)) return `string:${id}`;
  fail("Invalid server request identity.");
}
function equalSecret(a, b) {
  return typeof a === "string" && typeof b === "string" && /^[a-f0-9]{64}$/u.test(a)
    && /^[a-f0-9]{64}$/u.test(b) && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function normalizeRequest(message, lane) {
  if (!SUPPORTED.has(message?.method)) fail("Unsupported server request.", "FLEET_INBOX_UNSUPPORTED");
  const key = rpcKey(message.id), p = message.params;
  if (!object(p) || Buffer.byteLength(JSON.stringify(p)) > 48 * 1024) fail("Oversized or malformed request.");
  for (const name of ["threadId", "turnId", "itemId"]) text(p[name], 256, name);
  if (p.threadId !== lane.threadId || p.turnId !== lane.turnId || !["running", "starting"].includes(lane.status)) {
    fail("Server request does not belong to the current owned turn.", "FLEET_INBOX_STALE");
  }
  let kind = "approval";
  if (message.method === INBOX_METHODS.input) {
    if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > 8) fail("Expected 1-8 questions.");
    const ids = new Set();
    for (const q of p.questions) {
      if (!object(q)) fail("Malformed question.");
      text(q.id, 128, "question identity");
      if (ids.has(q.id) || DANGEROUS_KEYS.has(q.id)) fail("Duplicate or unsafe question identity.");
      ids.add(q.id);
      text(q.header, 160, "question header"); text(q.question, 8192, "question", true);
      // Secrets remain in the owning Codex client; do not put them in shared memory, CLI output or logs.
      if (q.isSecret !== false) fail("Secret or unclassified-secret input must use the owning client.");
      if (typeof q.isOther !== "boolean") fail("Question free-text policy is missing.");
      if (q.options !== null && q.options !== undefined) {
        if (!Array.isArray(q.options) || !q.options.length || q.options.length > 16) fail("Invalid question options.");
        const labels = new Set();
        for (const option of q.options) {
          text(option?.label, 256, "option label");
          text(option?.description, 2048, "option description", true);
          if (labels.has(option.label)) fail("Duplicate option label.");
          labels.add(option.label);
        }
      }
    }
    // A warning heuristic can only REDUCE authority. Every delegation still requires human review.
    const approvalShaped = p.questions.some((q) => /\b(accept|decline|approve|permission|authorize|consent|grant|onay|izin)\b/iu.test(JSON.stringify(q)));
    kind = approvalShaped ? "approval" : "question";
  } else if (lane.interactive !== true) {
    fail("This lane did not opt in to interactive operation approvals.");
  }
  if (message.method === INBOX_METHODS.command && typeof p.command !== "string") {
    if (!object(p.networkApprovalContext) || typeof p.networkApprovalContext.host !== "string" || typeof p.networkApprovalContext.protocol !== "string") fail("Command or network destination is missing.");
  }
  const fileContext = message.method === INBOX_METHODS.file ? lane.interventionItems?.get(p.itemId) : null;
  const rendered = fileContext ? { request: p, proposedChanges: fileContext } : p;
  const original = JSON.stringify(rendered, null, 2);
  // Redact each bounded string, not the whole JSON (which could otherwise truncate at 8192 chars).
  const details = JSON.stringify(rendered, (_key, value) => typeof value === "string" ? redactText(value) : value, 2);
  return { rpcKey: key, kind, details, completeDetails: original === details && (message.method !== INBOX_METHODS.file || Boolean(fileContext)),
    params: copy(p), method: message.method, wireId: message.id };
}

/** Live, connection-local requests. No prompts, answers, grants or secrets are written to disk. */
export class InterventionInbox {
  constructor(options) {
    if (typeof options?.send !== "function" || typeof options?.isCurrent !== "function") fail("Inbox requires transport and ownership checks.");
    this.send = options.send; this.isCurrent = options.isCurrent;
    this.now = options.now ?? Date.now; this.onChange = options.onChange ?? (() => {});
    this.requestTtlMs = options.requestTtlMs ?? 15 * 60_000;
    this.entries = new Map(); this.identities = new Map(); this.previews = new Map(); this.version = 0;
  }
  changed(entry) {
    this.version += 1;
    try { this.onChange(entry.laneId); } catch { /* Observers cannot authorize or break request state. */ }
  }
  validate(message, lane) { normalizeRequest(message, lane); }
  receive(message, lane) {
    this.sweep();
    const request = normalizeRequest(message, lane);
    const fingerprint = hash({ method: message.method, params: message.params });
    const prior = this.identities.get(request.rpcKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail("Conflicting reused server request identity.", "FLEET_INBOX_COLLISION");
      return prior.id; // Exact replay is not a new question or another response opportunity.
    }
    if (this.identities.size >= 4096) fail("Connection request identity budget exhausted; reconnect explicitly.");
    if ([...this.entries.values()].filter((e) => !TERMINAL.has(e.state)).length >= 64) fail("Intervention inbox capacity reached.");
    const entry = { ...request, id: crypto.randomUUID(), laneId: lane.id, threadId: lane.threadId,
      turnId: lane.turnId, itemId: message.params.itemId, fingerprint, revision: 1, state: "pending",
      receivedAt: this.now(), expiresAt: this.now() + this.requestTtlMs, proposal: null, delegation: null };
    entry.title = entry.method === INBOX_METHODS.input ? redactText(entry.params.questions[0].header) : entry.method === INBOX_METHODS.command ? "Command approval" : entry.method === INBOX_METHODS.file ? "File change approval" : "Permission request";
    this.entries.set(entry.id, entry); this.identities.set(entry.rpcKey, { id: entry.id, fingerprint }); this.changed(entry);
    this.prune(); return entry.id;
  }
  prune() {
    for (const entry of this.entries.values()) {
      if (this.entries.size <= 128) break;
      if (TERMINAL.has(entry.state)) { this.entries.delete(entry.id); }
    }
    for (const [token, item] of this.previews) if (item.expiresAt <= this.now()) this.previews.delete(token);
  }
  sweep() {
    for (const entry of this.entries.values()) {
      if (["sending", "sent"].includes(entry.state) && entry.expiresAt <= this.now()) this.finish(entry, "unknown", "server-clear-not-observed");
      if (!OPEN.has(entry.state)) continue;
      if (!this.isCurrent(entry)) this.finish(entry, "expired", "turn-ended");
      else if (entry.expiresAt <= this.now()) {
        this.finish(entry, "expired", "request-timeout");
        // Explicit fail-closed response. Never auto-accept and never retry delivery.
        Promise.resolve().then(() => this.send(entry.wireId, { error: { code: -32000, message: "Fleet intervention timed out; no permission granted." } })).catch(() => {
          if (entry.state === "expired") this.finish(entry, "unknown", "timeout-delivery-unknown");
        });
      } else if (entry.delegation && entry.delegation.expiresAt <= this.now()) {
        entry.delegation = null; entry.state = "pending"; entry.revision += 1; this.changed(entry);
      }
    }
    this.prune();
  }
  finish(entry, state, reason) {
    entry.state = state; entry.reason = reason; entry.revision += 1; entry.delegation = null;
    entry.proposal = null; entry.params = null;
    entry.details = "The live request was cleared. Only identity, state and digests are retained; no answer is replayable.";
    this.changed(entry);
  }
  invalidateTurn(threadId, turnId, reason = "turn-ended") {
    for (const entry of this.entries.values()) if (entry.threadId === threadId && entry.turnId === turnId && !TERMINAL.has(entry.state)) this.finish(entry, "expired", reason);
  }
  disconnect() {
    for (const entry of this.entries.values()) if (!TERMINAL.has(entry.state)) this.finish(entry, ["sending", "sent"].includes(entry.state) ? "unknown" : "expired", "connection-ended");
    this.previews.clear();
  }
  resolved(threadId, requestId) {
    let key; try { key = rpcKey(requestId); } catch { return; }
    const entry = this.entries.get(this.identities.get(key)?.id);
    if (entry && entry.threadId === threadId && !TERMINAL.has(entry.state)) this.finish(entry, "resolved", "server-cleared");
  }
  snapshot(entry, detail = false) {
    return { id: entry.id, laneId: entry.laneId, threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId,
      kind: entry.kind, method: entry.method, state: entry.state, revision: entry.revision,
      receivedAt: entry.receivedAt, expiresAt: entry.expiresAt, reason: entry.reason ?? null,
      requestDigest: entry.fingerprint, responseDigest: entry.responseDigest ?? null,
      hasProposal: Boolean(entry.proposal), completeDetails: entry.completeDetails,
      title: entry.title,
      ...(detail ? { details: entry.details, questions: entry.params && entry.method === INBOX_METHODS.input ? JSON.parse(JSON.stringify(entry.params.questions, (_key, value) => typeof value === "string" ? redactText(value) : value)) : null,
        proposal: entry.proposal ? copy(entry.proposal) : null,
        delegation: entry.delegation ? { token: entry.delegation.token, expiresAt: entry.delegation.expiresAt } : null,
        actions: this.actions(entry) } : {}) };
  }
  actions(entry) {
    if (!OPEN.has(entry.state)) return [];
    const actions = ["reject"];
    if (entry.delegation) actions.push("takeover");
    if (!entry.completeDetails) return actions;
    if (entry.method === INBOX_METHODS.input) {
      actions.push("answer");
      if (entry.kind === "question" && !entry.delegation) actions.push("delegate");
    } else if ((entry.params.availableDecisions === undefined || (Array.isArray(entry.params.availableDecisions) && entry.params.availableDecisions.includes("accept")))
      && (entry.method !== INBOX_METHODS.permissions || this.permissionGrant(entry) !== null)) actions.push("accept");
    return actions;
  }
  permissionGrant(entry) {
    const p = entry.params.permissions;
    if (!object(p) || Object.keys(p).some((key) => !["network", "fileSystem"].includes(key))) return null;
    if (p.network != null && (!object(p.network) || Object.keys(p.network).some((key) => key !== "enabled") || ![true, false, null].includes(p.network.enabled))) return null;
    // Preserve the exact requested filesystem subset. Unknown future profiles remain deny-only.
    if (p.fileSystem != null && (!object(p.fileSystem) || Object.keys(p.fileSystem).some((key) => !["read", "write", "globScanMaxDepth", "entries"].includes(key)))) return null;
    return copy(Object.fromEntries(Object.entries(p).filter(([, value]) => value !== null)));
  }
  list() { this.sweep(); return { schemaVersion: 1, version: this.version, requests: [...this.entries.values()].map((entry) => this.snapshot(entry)) }; }
  inspect(id) { this.sweep(); const entry = this.entries.get(id); if (!entry) fail("Intervention no longer exists.", "FLEET_INBOX_STALE"); return this.snapshot(entry, true); }
  current(id, revision) {
    this.sweep(); const entry = this.entries.get(id);
    if (!entry || !OPEN.has(entry.state) || entry.revision !== revision || !this.isCurrent(entry)) fail("Request changed, expired or was already answered. Refresh before acting.", "FLEET_INBOX_STALE");
    return entry;
  }
  inputResult(entry, result) {
    keys(result, ["answers"]); if (!object(result.answers)) fail("Answers must be keyed by question identity.");
    const ids = entry.params.questions.map((q) => q.id);
    if (Object.keys(result.answers).length !== ids.length || Object.keys(result.answers).some((id) => !ids.includes(id))) fail("Answer every exact question once.");
    const answers = Object.create(null);
    for (const question of entry.params.questions) {
      const value = result.answers[question.id]; keys(value, ["answers"]);
      if (!Array.isArray(value.answers) || value.answers.length !== 1) fail("Exactly one answer per question is supported.");
      const answer = text(value.answers[0], 4096, "answer", true);
      if (redactText(answer) !== answer) fail("Sensitive answer must use the owning client.");
      if (question.options?.length && !question.isOther && !question.options.some((option) => option.label === answer)) fail("Answer must be an exact available option.");
      answers[question.id] = { answers: [answer] };
    }
    return { answers };
  }
  propose(id, revision, proposal) {
    const entry = this.current(id, revision); keys(proposal, ["note", "result"]);
    if (entry.state !== "pending" || !entry.completeDetails) fail("This request cannot accept a proposal.");
    const note = text(proposal.note, 4096, "proposal note", true);
    if (redactText(note) !== note) fail("Sensitive proposal must not enter the shared inbox.");
    const result = proposal.result === undefined ? null : entry.method === INBOX_METHODS.input ? this.inputResult(entry, proposal.result) : fail("Operation approvals accept advice, not model-issued permission.");
    entry.proposal = { note, result }; entry.revision += 1; this.changed(entry); return this.snapshot(entry, true);
  }
  normalizeAction(entry, action) {
    keys(action, ["type", "result"]);
    if (!this.actions(entry).includes(action.type)) fail("Action is not available for this request.");
    if (action.type === "answer") return { type: "answer", result: this.inputResult(entry, action.result) };
    if (action.result !== undefined) fail("Unexpected action result.");
    return { type: action.type };
  }
  preview(id, revision, action) {
    const entry = this.current(id, revision), normalized = this.normalizeAction(entry, action);
    if (this.previews.size >= 64) fail("Too many pending review previews.");
    const token = crypto.randomBytes(32).toString("hex");
    this.previews.set(token, { id, revision, action: normalized, expiresAt: this.now() + 60_000 });
    return { request: this.snapshot(entry, true), action: normalized, confirmationToken: token, expiresAt: this.now() + 60_000 };
  }
  async apply(token) {
    const preview = this.previews.get(token); this.previews.delete(token);
    if (!preview || preview.expiresAt <= this.now()) fail("Review confirmation expired.", "FLEET_INBOX_STALE");
    const entry = this.current(preview.id, preview.revision), action = this.normalizeAction(entry, preview.action);
    if (action.type === "delegate") {
      entry.revision += 1; entry.state = "delegated";
      entry.delegation = { token: crypto.randomBytes(32).toString("hex"), expiresAt: Math.min(entry.expiresAt, this.now() + 90_000), revision: entry.revision };
      this.changed(entry); return this.snapshot(entry, true);
    }
    if (action.type === "takeover") { entry.delegation = null; entry.state = "pending"; entry.revision += 1; this.changed(entry); return this.snapshot(entry, true); }
    let result;
    if (action.type === "answer") result = action.result;
    else if (entry.method === INBOX_METHODS.input) return this.deliver(entry, null, { code: -32000, message: "Human declined to answer this request." });
    else if (entry.method === INBOX_METHODS.permissions) result = { permissions: action.type === "accept" ? this.permissionGrant(entry) : {}, scope: "turn" };
    else if (action.type === "reject" && entry.params.availableDecisions && !entry.params.availableDecisions.includes?.("decline")) {
      return this.deliver(entry, null, { code: -32000, message: "Human rejected this request; no permission granted." });
    } else result = { decision: action.type === "accept" ? "accept" : "decline" };
    return this.deliver(entry, result);
  }
  async answerDelegated(id, revision, token, result) {
    const entry = this.current(id, revision), grant = entry.delegation;
    if (entry.kind !== "question" || entry.state !== "delegated" || !grant || grant.revision !== revision || grant.expiresAt <= this.now() || !equalSecret(grant.token, token)) fail("No current per-question delegation.", "FLEET_INBOX_DENIED");
    return this.deliver(entry, this.inputResult(entry, result));
  }
  async deliver(entry, result, error = null) {
    // Commit locally before yielding. Concurrent callers can never deliver twice.
    entry.responseDigest = hash(error ? { error } : { result });
    entry.state = "sending"; entry.revision += 1; entry.delegation = null; this.changed(entry);
    try {
      await this.send(entry.wireId, error ? { error } : { result });
      if (entry.state === "sending") { entry.state = "sent"; this.changed(entry); }
    } catch {
      if (!TERMINAL.has(entry.state)) this.finish(entry, "unknown", "response-delivery-unknown");
    }
    return this.snapshot(entry);
  }
}
