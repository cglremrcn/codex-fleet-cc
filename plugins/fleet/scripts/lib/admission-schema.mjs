import { LANE_ID_PATTERN, LANE_ROLES } from "./domain.mjs";

const text = (maxLength) => ({ type: "string", minLength: 1, maxLength, pattern: "\\S" });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const bools = (...names) => object(Object.fromEntries(names.map((name) => [name, { type: "boolean" }])));
const checks = { type: "array", maxItems: 32, items: text(2000) };
export const ADMISSION_AUTHORITY_SCHEMA = object({
  sandbox: { type: "string", enum: ["read-only", "workspace-write"] },
  network: { type: "string", enum: ["off", "live"] },
  browser: bools("inspect", "mutate"),
  process: object({ start: { type: "boolean", enum: [true] }, stopOwned: { type: "boolean" } }, ["start"]),
  database: bools("read", "write"), image: bools("generate", "edit"),
  externalEffects: bools("send", "payment", "deploy", "delete"), retry: { type: "boolean" }
}, ["process"]);
export const ADMISSION_LANE_SCHEMA = object({
  id: { ...text(64), pattern: LANE_ID_PATTERN.source }, role: { type: "string", enum: [...LANE_ROLES] },
  label: text(120), model: text(80), effort: text(32), prompt: { ...text(128 * 1024), "x-maxUtf8Bytes": 128 * 1024 },
  authority: ADMISSION_AUTHORITY_SCHEMA,
  ephemeral: { type: "boolean" }, interactive: { type: "boolean" }, checkoutKey: text(256), groupPath: text(160),
  priority: { type: "string", enum: ["high", "normal", "low"] }, retryOf: nullable(text(160)), reconciliationRef: nullable(text(512)),
  verificationPlan: object({ start: checks, completion: checks, controller: checks }),
  verificationCheckpoint: nullable({ type: "string", pattern: "^[a-f0-9]{64}$" })
}, ["id", "role", "label", "model", "effort", "prompt", "authority"]);
export const START_CONTRACT_SCHEMA = object({
  schemaVersion: { type: "integer", minimum: 1, maximum: 1 }, workspacePath: text(4096),
  lanes: { type: "array", minItems: 1, maxItems: 256, items: ADMISSION_LANE_SCHEMA },
  limits: object({ maxActive: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    maxWritersPerCheckout: { type: "integer", minimum: 1, maximum: 1 },
    staggerMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
  confirmationRef: nullable(text(512)), modelPolicy: { type: "string", enum: ["runtime"] },
  sharedContext: nullable({ ...text(32 * 1024), "x-maxUtf8Bytes": 32 * 1024 })
}, ["schemaVersion", "workspacePath", "lanes"]);

export const ADMISSION_SEMANTIC_CONSTRAINTS = Object.freeze([
  "Use a canonical absolute workspace path. The supervisor rejects another workspace.",
  "All IDs in a batch must be unique and absent from the retained ledger.",
  "Resolve exact model/effort pairs with control models and set root modelPolicy:runtime; omitted policy uses the legacy compatibility catalogue.",
  "The existing validator also checks UTF-8 prompt/context limits, control characters, logical group paths, retry lineage, and model/effort compatibility.",
  "Mutable authority requires a real previously obtained confirmationRef. A role, prepared plan or invented string is not a permission grant.",
  "verificationCheckpoint requires a new non-interactive, network-off, read-only independent-verifier and exact checkpoint completion checks.",
  "A batch cannot mix a checkpoint verifier with mutable work; use separate source-consistent waves."
]);
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
freeze(START_CONTRACT_SCHEMA);
