import path from "node:path";

import {
  normalizeAuthority,
  requiredAdmissionConfirmationActions
} from "./authority.mjs";
import { LANE_ID_PATTERN, LANE_ROLES } from "./domain.mjs";

const MAX_CONTRACT_BYTES = 128 * 1024;
const PRIORITIES = new Set(["high", "normal", "low"]);
const ROOT_PROPERTIES = new Set([
  "schemaVersion",
  "workspacePath",
  "lanes",
  "limits",
  "confirmationRef"
]);
const LANE_PROPERTIES = new Set([
  "id",
  "role",
  "label",
  "model",
  "effort",
  "prompt",
  "ephemeral",
  "authority",
  "checkoutKey",
  "priority",
  "retryOf",
  "reconciliationRef"
]);
const AUTHORITY_PROPERTIES = new Set([
  "sandbox",
  "network",
  "browser",
  "process",
  "database",
  "image",
  "externalEffects",
  "retry"
]);
const AUTHORITY_NESTED_PROPERTIES = Object.freeze({
  browser: new Set(["inspect", "mutate"]),
  process: new Set(["start", "stopOwned"]),
  database: new Set(["read", "write"]),
  image: new Set(["generate", "edit"]),
  externalEffects: new Set(["send", "payment", "deploy", "delete"])
});
const LIMIT_PROPERTIES = new Set(["maxActive", "maxWritersPerCheckout", "staggerMs"]);
const UNSUPPORTED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/u;
const ROLE_VALUES = new Set(LANE_ROLES);

export class StartContractValidationError extends Error {
  constructor(issues) {
    const lines = issues.map((issue) => `- ${issue.path}: ${issue.message}`);
    super(["Fleet start contract validation failed:", ...lines].join("\n"));
    this.name = "StartContractValidationError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
    this.category = issues.some((issue) => issue.kind === "input")
      ? "invalidInput"
      : "authorityDenied";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addIssue(issues, kind, propertyPath, message) {
  issues.push({ kind, path: propertyPath, message });
}

function collectUnknownProperties(value, allowed, propertyPath, issues) {
  for (const property of Object.keys(value)) {
    if (!allowed.has(property)) {
      const message = propertyPath === "$"
        ? `Unknown contract property: ${property}.`
        : `Unknown ${propertyPath} property: ${property}.`;
      addIssue(issues, "input", `${propertyPath}.${property}`, message);
    }
  }
}

function collectBoundedText(value, propertyPath, maximum, issues, options = {}) {
  const length = options.bytes === true && typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : value?.length;
  if (typeof value !== "string" || !value.trim() || length > maximum) {
    addIssue(
      issues,
      "input",
      propertyPath,
      `must contain between 1 and ${maximum} characters.`
    );
    return null;
  }
  const controlPattern = options.multiline === true ? UNSUPPORTED_CONTROL : ANY_CONTROL;
  if (controlPattern.test(value)) {
    addIssue(issues, "input", propertyPath, "contains unsupported control characters.");
    return null;
  }
  return value;
}

function collectBoolean(value, propertyPath, issues) {
  if (value !== undefined && typeof value !== "boolean") {
    addIssue(issues, "input", propertyPath, "must be a boolean.");
  }
}

function collectAuthority(value, propertyPath, issues) {
  if (!isPlainObject(value)) {
    addIssue(issues, "input", propertyPath, "must be an object.");
    return null;
  }
  const issueCount = issues.length;
  collectUnknownProperties(value, AUTHORITY_PROPERTIES, propertyPath, issues);
  if (value.sandbox !== undefined && !["read-only", "workspace-write"].includes(value.sandbox)) {
    addIssue(issues, "input", `${propertyPath}.sandbox`, "must be read-only or workspace-write.");
  }
  if (value.network !== undefined && !["off", "live"].includes(value.network)) {
    addIssue(issues, "input", `${propertyPath}.network`, "must be off or live.");
  }
  collectBoolean(value.retry, `${propertyPath}.retry`, issues);
  for (const [name, allowed] of Object.entries(AUTHORITY_NESTED_PROPERTIES)) {
    const nested = value[name];
    if (nested === undefined) continue;
    if (!isPlainObject(nested)) {
      addIssue(issues, "input", `${propertyPath}.${name}`, "must be an object.");
      continue;
    }
    collectUnknownProperties(nested, allowed, `${propertyPath}.${name}`, issues);
    for (const key of allowed) {
      collectBoolean(nested[key], `${propertyPath}.${name}.${key}`, issues);
    }
  }
  if (issues.length !== issueCount) return null;
  return normalizeAuthority(value);
}

function collectLimits(value, issues) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    addIssue(issues, "input", "limits", "must be an object.");
    return undefined;
  }
  collectUnknownProperties(value, LIMIT_PROPERTIES, "limits", issues);
  for (const [name, minimum] of [["maxActive", 1], ["maxWritersPerCheckout", 1], ["staggerMs", 0]]) {
    if (value[name] === undefined) continue;
    if (!Number.isSafeInteger(value[name]) || value[name] < minimum) {
      addIssue(
        issues,
        "input",
        `limits.${name}`,
        `must be an integer greater than or equal to ${minimum}.`
      );
    }
  }
  return value;
}

function collectLane(value, index, confirmationRef, issues) {
  const propertyPath = `lanes[${index}]`;
  if (!isPlainObject(value)) {
    addIssue(issues, "input", propertyPath, "must be an object.");
    return null;
  }
  collectUnknownProperties(value, LANE_PROPERTIES, propertyPath, issues);
  const id = collectBoundedText(value.id, `${propertyPath}.id`, 64, issues);
  if (id && !LANE_ID_PATTERN.test(id)) {
    addIssue(issues, "input", `${propertyPath}.id`, "must be URL-safe (letters, numbers, _ or -).");
  }
  const role = collectBoundedText(value.role, `${propertyPath}.role`, 64, issues);
  if (role && !ROLE_VALUES.has(role)) {
    addIssue(issues, "input", `${propertyPath}.role`, `must be one of: ${LANE_ROLES.join(", ")}.`);
  }
  collectBoundedText(value.label, `${propertyPath}.label`, 120, issues);
  collectBoundedText(value.model, `${propertyPath}.model`, 80, issues);
  collectBoundedText(value.effort, `${propertyPath}.effort`, 32, issues);
  collectBoundedText(value.prompt, `${propertyPath}.prompt`, MAX_CONTRACT_BYTES, issues, {
    bytes: true,
    multiline: true
  });
  if (value.checkoutKey !== undefined) {
    collectBoundedText(value.checkoutKey, `${propertyPath}.checkoutKey`, 256, issues);
  }
  if (value.retryOf !== undefined && value.retryOf !== null) {
    const retryOf = collectBoundedText(value.retryOf, `${propertyPath}.retryOf`, 64, issues);
    if (retryOf && !LANE_ID_PATTERN.test(retryOf)) {
      addIssue(issues, "input", `${propertyPath}.retryOf`, "must reference a URL-safe lane ID.");
    }
  }
  if (value.reconciliationRef !== undefined && value.reconciliationRef !== null) {
    collectBoundedText(
      value.reconciliationRef,
      `${propertyPath}.reconciliationRef`,
      512,
      issues
    );
  }
  collectBoolean(value.ephemeral, `${propertyPath}.ephemeral`, issues);
  if (value.priority !== undefined && !PRIORITIES.has(value.priority)) {
    addIssue(issues, "input", `${propertyPath}.priority`, "must be high, normal, or low.");
  }
  const authority = collectAuthority(value.authority, `${propertyPath}.authority`, issues);
  if (!authority) return null;
  if (!authority.process.start) {
    addIssue(
      issues,
      "authority",
      `${propertyPath}.authority.process.start`,
      "must be granted before a lane can be admitted."
    );
  }
  const actions = requiredAdmissionConfirmationActions(authority);
  if (actions.length > 0 && !confirmationRef) {
    addIssue(
      issues,
      "authority",
      "confirmationRef",
      `confirmation reference is required for lane ${String(value.id ?? index + 1)}: `
        + `${actions.join(", ")}.`
    );
  }
  return {
    ...value,
    priority: value.priority ?? "normal",
    authority
  };
}

export function validateStartContract(value, options = {}) {
  const issues = [];
  if (!isPlainObject(value)) {
    throw new StartContractValidationError([{
      kind: "input",
      path: "$",
      message: "must be an object."
    }]);
  }
  collectUnknownProperties(value, ROOT_PROPERTIES, "$", issues);
  if (value.schemaVersion !== 1) {
    addIssue(issues, "input", "schemaVersion", "must be 1.");
  }

  const workspaceText = collectBoundedText(value.workspacePath, "workspacePath", 4096, issues);
  const workspacePath = workspaceText ? path.resolve(workspaceText) : null;
  if (
    workspacePath
    && options.expectedWorkspacePath
    && workspacePath !== path.resolve(options.expectedWorkspacePath)
  ) {
    addIssue(issues, "input", "workspacePath", "does not match the supervisor workspace.");
  }

  let confirmationRef = null;
  if (value.confirmationRef !== undefined && value.confirmationRef !== null) {
    confirmationRef = collectBoundedText(value.confirmationRef, "confirmationRef", 512, issues);
  }

  const lanes = [];
  const laneIds = new Set();
  if (!Array.isArray(value.lanes) || value.lanes.length === 0 || value.lanes.length > 256) {
    addIssue(issues, "input", "lanes", "must contain between 1 and 256 lanes.");
  } else {
    for (let index = 0; index < value.lanes.length; index += 1) {
      const lane = collectLane(value.lanes[index], index, confirmationRef, issues);
      if (lane) {
        if (typeof lane.id === "string" && laneIds.has(lane.id)) {
          addIssue(issues, "input", `lanes[${index}].id`, `duplicate lane ID: ${lane.id}.`);
        }
        laneIds.add(lane.id);
        lanes.push(lane);
      }
    }
  }
  const limits = collectLimits(value.limits, issues);

  if (issues.length > 0) throw new StartContractValidationError(issues);
  return Object.freeze({
    schemaVersion: 1,
    workspacePath,
    lanes: Object.freeze(lanes),
    limits,
    confirmationRef
  });
}
