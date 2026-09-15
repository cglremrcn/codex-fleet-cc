import crypto from "node:crypto";
import { START_CONTRACT_SCHEMA, ADMISSION_SEMANTIC_CONSTRAINTS } from "./admission-schema.mjs";

export const CONTROL_VERSION = 1;
export const MAX_CONTROL_BYTES = 128 * 1024;
export const MAX_CONTROL_REPLY_BYTES = 240 * 1024;
const ID = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" };
const HASH = { type: "string", pattern: "^[a-f0-9]{64}$" };
const TOKEN = { type: "string", minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9_.-]+$" };
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, maxItems, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const CHECKS = { ...array(text(256), 16, 1), uniqueItems: true };
const CONTRACT = START_CONTRACT_SCHEMA; // Structural schema; existing admission validator enforces semantic gates.
const DEPENDENCY = object({ laneId: ID, receiptId: HASH }, ["laneId"]);
const GRAPH_NODE = object({
  id: ID,
  dependsOn: array(DEPENDENCY, 32),
  estimatedTokens: integer(1, 100_000_000),
  estimatedMs: integer(1, 86_400_000),
  waitSince: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
}, ["id", "estimatedTokens", "estimatedMs"]);
const PLAN = object({
  contract: CONTRACT,
  graph: array(GRAPH_NODE, 256, 1),
  budget: object({
    maxEstimatedTokens: integer(1, 1_000_000_000),
    verificationReserveTokens: integer(0, 1_000_000_000)
  }, ["maxEstimatedTokens", "verificationReserveTokens"]),
  strategy: { type: "string", enum: ["critical-path", "fifo"] }
}, ["contract", "graph", "budget"]);

const definitions = {
  describe: {
    effect: "none", retry: "safe", summary: "Discover operations, then request one exact input schema. No workspace or runtime needed.",
    params: object({ operation: text(48) }), example: { operation: "observe" }
  },
  observe: {
    effect: "local-observation", retry: "safe", summary: "Bounded state deltas. May start the local supervisor, never a Codex model turn. Buffer pages until cursor is present.",
    params: object({ cursor: TOKEN, nextPage: TOKEN, maxBytes: integer(2048, 65536), includeUsage: { type: "boolean" } }), example: { maxBytes: 8192 }
  },
  result: {
    effect: "local-observation", retry: "safe", summary: "Read a sanitized result or one revision-bound paged section. Prefer identity then needed work/checks/artifacts/evidence/events; full remains available.",
    params: object({ laneId: ID, section: { type: "string", enum: ["full", "identity", "work", "checks", "artifacts", "evidence", "events"] }, revision: HASH, offset: integer(0, 4096), textOffset: integer(0, 2097152), maxBytes: integer(2048, 65536) }, ["laneId"]), example: { laneId: "implement", section: "identity" }
  },
  models: {
    effect: "runtime-discovery", retry: "safe", summary: "Discover exact model/effort identifiers. May initialize Codex app-server, never inference.",
    params: object({}), example: {}
  },
  wait: {
    effect: "runtime-observation", retry: "safe", summary: "Long-poll coalesced state after a cursor. Avoid the observe/wait lost-wakeup gap; never starts Codex. Timeout is not failure.",
    params: object({ cursor: TOKEN, includeUsage: { type: "boolean" }, timeoutMs: integer(1, 3_600_000) }), example: { timeoutMs: 600000 }
  },
  start: {
    effect: "model-turn", retry: "reconcile-first", summary: "Admit an unchanged Fleet start contract. Existing sandbox, confirmation and model-catalogue gates apply.",
    params: object({ contract: CONTRACT }, ["contract"]), example: null
  },
  continue: {
    effect: "model-turn", retry: "reconcile-first", summary: "Continue one existing owned thread, never widen authority. Unknown outcomes must be reconciled first.",
    params: object({ laneId: ID, message: text(32 * 1024), expectedThreadId: text(256), expectedTurnId: text(256), expectedExecutionRevision: integer(0, Number.MAX_SAFE_INTEGER) }, ["laneId", "message", "expectedThreadId", "expectedTurnId", "expectedExecutionRevision"]), example: null
  },
  "cancel.preview": {
    effect: "local-observation", retry: "safe", summary: "Preview cancellation pinned to the current owned lane/thread/turn. Does not cancel work.",
    params: object({ laneId: ID }, ["laneId"]), example: { laneId: "implement" }
  },
  "cancel.apply": {
    effect: "runtime-mutation", retry: "reconcile-first", summary: "Apply the exact cancellation preview after the operator decision. Does not undo prior side effects.",
    params: object({ laneId: ID, confirmationToken: HASH, expectedThreadId: nullable(text(256)), expectedTurnId: nullable(text(256)) }, ["laneId", "confirmationToken", "expectedThreadId", "expectedTurnId"]), example: null
  },
  checkpoint: {
    effect: "local-evidence-write", retry: "safe", summary: "Bind a completed worker, immutable contract digest, required checks and actual workspace bytes. No inference or command execution.",
    params: object({ laneId: ID, requiredChecks: CHECKS }, ["laneId", "requiredChecks"]), example: { laneId: "implement", requiredChecks: ["unit", "typecheck"] }
  },
  attest: {
    effect: "local-evidence-write", retry: "safe", summary: "Bind a fresh checkpoint-specific read-only verifier and its reported passed checks. Hash evidence files; not a signed execution proof or release authorization.",
    params: object({ checkpointId: HASH, verifierLaneId: ID,
      evidenceFiles: array(object({ check: text(256), path: text(512) }, ["check", "path"]), 32, 1)
    }, ["checkpointId", "verifierLaneId", "evidenceFiles"]), example: null
  },
  check: {
    effect: "local-observation", retry: "safe", summary: "Revalidate an evidence receipt against current source, lane/turn identities and artifact hashes. Never equates a historical verdict with current readiness.",
    params: object({ receiptId: HASH }, ["receiptId"]), example: null
  },
  prepare: {
    effect: "local-plan", retry: "safe", summary: "Prepare the ready DAG frontier with critical-path/aging priority, capacity and estimated-token reserve. Keeps at most one bounded current-wave contract in a short-lived plan; no inference.",
    params: PLAN, example: null
  },
  apply: {
    effect: "model-turn", retry: "same-plan-only", summary: "Apply an unchanged prepared frontier once. Recheck dependencies, source receipts and capacity. Same live plan replays its result, never a second admission; after restart reconcile first.",
    params: object({ planToken: TOKEN }, ["planToken"]), example: null
  }
};

export const CONTROL_OPERATIONS = Object.freeze(Object.keys(definitions));
export class ControlError extends Error {
  constructor(code, message, options = {}) {
    super(message); this.name = "ControlError"; this.code = code;
    this.path = options.path ?? null; this.retry = options.retry ?? "safe";
  }
}
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) ?? "null").join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
export function digest(value, domain = "fleet-control-v1") {
  return crypto.createHash("sha256").update(domain).update("\0").update(canonicalJson(value)).digest("hex");
}

function checkShape(value, schema, location = "$", depth = 0) {
  const bad = (rule) => { throw new ControlError("INVALID_CONTROL_REQUEST", `Invalid ${location}: ${rule}.`, { path: location }); };
  if (depth > 16) bad("maximum nesting depth is 16");
  if (schema.anyOf) {
    for (const candidate of schema.anyOf) {
      try { checkShape(value, candidate, location, depth + 1); return; } catch (error) { if (!(error instanceof ControlError)) throw error; }
    }
    bad("does not match the permitted alternatives");
  }
  const kind = schema.type;
  if (kind === "null") { if (value !== null) bad("expected null"); return; }
  if (kind === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad("expected an object");
    const keys = Object.keys(value);
    if (keys.length > 256) bad("too many properties");
    if (schema.additionalProperties === false && keys.some((key) => !Object.hasOwn(schema.properties, key))) bad("unknown property");
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) bad(`missing ${key}`);
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) checkShape(value[key], property, `${location}.${key}`, depth + 1);
    }
  } else if (kind === "array") {
    if (!Array.isArray(value)) bad("expected an array");
    if (value.length < (schema.minItems ?? 0) || value.length > schema.maxItems) bad("array length out of bounds");
    value.forEach((item, index) => checkShape(item, schema.items, `${location}[${index}]`, depth + 1));
    if (schema.uniqueItems && new Set(value.map((item) => canonicalJson(item))).size !== value.length) bad("duplicate items");
  } else if (kind === "string") {
    if (typeof value !== "string" || !value.trim()
      || Array.from(value).length < (schema.minLength ?? 0) || Array.from(value).length > (schema.maxLength ?? 1024)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) bad("invalid or oversized text");
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) bad("invalid format");
  } else if (kind === "integer") {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) bad("integer out of bounds");
  } else if (kind === "boolean" && typeof value !== "boolean") bad("expected a boolean");
  if (schema.enum && !schema.enum.includes(value)) bad("unsupported value");
}

export function assertControlJsonBudget(value) {
  let nodes = 0; const seen = new WeakSet(); const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > 16384 || depth > 16) throw new ControlError("INVALID_CONTROL_REQUEST", "JSON structure exceeds depth or node budget.");
    if (item && typeof item === "object") {
      if (seen.has(item)) throw new ControlError("INVALID_CONTROL_REQUEST", "JSON structure must not contain shared/cyclic objects.");
      seen.add(item);
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    } else if (!["string", "number", "boolean", "undefined"].includes(typeof item) && item !== null) {
      throw new ControlError("INVALID_CONTROL_REQUEST", "JSON contains a non-data value.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_CONTROL_BYTES) throw new ControlError("INVALID_CONTROL_REQUEST", "JSON request exceeds the UTF-8 byte budget.");
}

export function validateControlOperation(operation, params) {
  assertControlJsonBudget(params);
  if (typeof operation !== "string" || !Object.hasOwn(definitions, operation)) {
    throw new ControlError("UNKNOWN_CONTROL_OPERATION", "Unknown operation. Call control describe for the supported surface.");
  }
  checkShape(params, definitions[operation].params, "$.params");
  if (operation === "observe" && params.nextPage && (params.cursor || params.maxBytes !== undefined || params.includeUsage !== undefined)) {
    throw new ControlError("INVALID_CONTROL_REQUEST", "nextPage must be used alone; its projection and byte budget are already bound.");
  }
  return params;
}
export function validateControlRequest(value) {
  assertControlJsonBudget(value);
  checkShape(value, object({ schemaVersion: integer(1, 1), requestId: ID, operation: text(48), workspacePath: text(4096), params: { type: "object" } }, ["schemaVersion", "operation", "params"]));
  validateControlOperation(value.operation, value.params);
  if (value.operation !== "describe" && !value.workspacePath) {
    throw new ControlError("INVALID_CONTROL_REQUEST", "workspacePath is required for this operation.", { path: "$.workspacePath" });
  }
  return value;
}

export function describeControl(operation) {
  if (operation !== undefined && !Object.hasOwn(definitions, operation)) {
    throw new ControlError("UNKNOWN_CONTROL_OPERATION", "Unknown operation. Request the index without an operation name.");
  }
  if (operation !== undefined) {
    const definition = definitions[operation];
    return { schemaVersion: CONTROL_VERSION, operation, effect: definition.effect, retry: definition.retry,
      description: definition.summary, paramsSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...definition.params },
      ...(definition.example === null ? {} : { exampleParams: definition.example }),
      ...(operation === "start" || operation === "prepare" ? { contractSemanticConstraints: ADMISSION_SEMANTIC_CONSTRAINTS } : {}) };
  }
  return { schemaVersion: CONTROL_VERSION, protocol: "fleet.control.v1", transport: "fleet control --stdin --json",
    maxRequestBytes: MAX_CONTROL_BYTES, operationCount: CONTROL_OPERATIONS.length,
    operations: CONTROL_OPERATIONS.map((name) => ({ name, effect: definitions[name].effect, retry: definitions[name].retry })),
    workflow: ["describe one operation", "observe", "prepare/apply or existing start", "wait", "result on demand", "checkpoint → fresh bound verifier → attest → check"],
    boundaries: ["No human approval impersonation or native-thread adoption", "Plans are not authority grants", "Reported tokens are not subscription quota", "Source receipts bind evidence, not universal correctness"] };
}
export function controlEffect(operation) { return definitions[operation]?.effect ?? "none"; }
export function controlRetry(operation) { return definitions[operation]?.retry ?? "safe"; }
