import path from "node:path";

import { redactText } from "./redaction.mjs";

export const MAX_AUTOMATIC_CONTINUATIONS = 2;

const EXECUTION_POSTURE_LINES = Object.freeze([
  "This admitted Fleet contract is authorization from the controller for work inside its exact authority.",
  "Execute and verify the work in this turn; do not stop at a plan or request redundant approval.",
  "The controller owns Git commits; do not create, amend, or rewrite commits in a lane.",
  "On Windows PowerShell 5.1, do not use `&&`; run each command separately and inspect each exit result.",
  "Persist intermediate findings and evidence before long-running test suites so an interruption does not erase them.",
  "If the sandbox blocks a build or dev-server command, report the exact blocked command and request controller verification; do not claim the check passed.",
  "A verification gate must measure behavior or an explicit contract; do not pin incidental source text unless the contract requires that exact text.",
  "When running a mutation check, prove that the mutation was actually applied before interpreting the gate result. On Windows, use a workspace-visible scratch path rather than assuming /tmp is shared across runtimes.",
  "Do not satisfy one gate by moving data or behavior into another gate's blind spot. Report the tradeoff instead.",
  "Treat the final report as a claim about the artifact. If report text looks anomalous, verify the actual files/evidence before changing the artifact to match the report.",
  "Visual or rendered-behavior claims require browser or visual evidence. If that capability is unavailable, report the check as skipped or blocked; never infer a pass from source text alone.",
  "Never widen authority. If genuinely required authority or input is missing, report it in the structured outcome so the controller can decide."
]);

export function executionPostureLines() {
  return [...EXECUTION_POSTURE_LINES];
}

const OUTCOMES = Object.freeze([
  "accomplished",
  "continue_within_authority",
  "needs_controller",
  "blocked"
]);
const REQUEST_KINDS = Object.freeze([
  "redundant_approval",
  "new_authority",
  "external_effect",
  "missing_input",
  "user_choice",
  "runtime_blocker"
]);
const CONTROLLER_ONLY_REQUESTS = new Set([
  "new_authority",
  "external_effect",
  "missing_input",
  "user_choice",
  "runtime_blocker"
]);
const REQUIRED_ROOT_FIELDS = new Set([
  "outcome",
  "summary",
  "workPerformed",
  "evidenceRefs"
]);
const OPTIONAL_ROOT_DEFAULTS = Object.freeze({
  artifactRefs: Object.freeze([]),
  verification: Object.freeze([]),
  verificationResults: Object.freeze([]),
  commitRefs: Object.freeze([]),
  configChanges: Object.freeze([]),
  controllerRequest: null,
  stopReason: null
});
const ROOT_FIELDS = new Set([
  ...REQUIRED_ROOT_FIELDS,
  ...Object.keys(OPTIONAL_ROOT_DEFAULTS)
]);
const DIAGNOSTIC_FIELDS = Object.freeze([...ROOT_FIELDS, "json"]);

export const LANE_OUTCOME_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [...ROOT_FIELDS],
  properties: {
    outcome: { type: "string", enum: [...OUTCOMES] },
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
    workPerformed: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 4_096 }
    },
    evidenceRefs: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 512 }
    },
    artifactRefs: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 256 }
    },
    verification: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 4_096 }
    },
    verificationResults: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "status", "evidence", "reason"],
        properties: {
          check: { type: "string", minLength: 1, maxLength: 512 },
          status: { type: "string", enum: ["passed", "failed", "skipped", "blocked"] },
          evidence: {
            anyOf: [
              { type: "null" },
              { type: "string", minLength: 1, maxLength: 2_000 }
            ]
          },
          reason: {
            anyOf: [
              { type: "null" },
              { type: "string", minLength: 1, maxLength: 2_000 }
            ]
          }
        }
      }
    },
    commitRefs: {
      type: "array",
      maxItems: 64,
      items: { type: "string", pattern: "^[a-fA-F0-9]{7,64}$" }
    },
    configChanges: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 256 }
    },
    controllerRequest: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "question"],
          properties: {
            kind: { type: "string", enum: [...REQUEST_KINDS] },
            question: { type: "string", minLength: 1, maxLength: 2_000 }
          }
        }
      ]
    },
    stopReason: {
      anyOf: [
        { type: "null" },
        { type: "string", minLength: 1, maxLength: 2_000 }
      ]
    }
  }
});

function boundedText(value, label, maximum, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${label} must be a safe string no longer than ${maximum} characters.`);
  }
  const text = redactText(value).trim();
  if (!allowEmpty && !text) throw new TypeError(`${label} cannot be empty.`);
  return text;
}

function boundedList(value, label, maximumItems) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TypeError(`${label} must be an array with at most ${maximumItems} items.`);
  }
  return Object.freeze(value.map((item, index) => (
    boundedText(item, `${label}[${index}]`, ["verification", "workPerformed"].includes(label) ? 4_096 : 512)
  )));
}

function verificationResultList(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TypeError("verificationResults must be an array with at most 32 items.");
  }
  return Object.freeze(value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`verificationResults[${index}] must be an object.`);
    }
    const keys = Object.keys(item);
    if (keys.some((key) => !["check", "status", "evidence", "reason"].includes(key))) {
      throw new TypeError(`verificationResults[${index}] contains unsupported fields.`);
    }
    if (!["passed", "failed", "skipped", "blocked"].includes(item.status)) {
      throw new TypeError(`verificationResults[${index}].status is unsupported.`);
    }
    return Object.freeze({
      check: boundedText(item.check, `verificationResults[${index}].check`, 512),
      status: item.status,
      evidence: item.evidence === null
        ? null
        : boundedText(item.evidence, `verificationResults[${index}].evidence`, 2_000),
      reason: item.reason === null
        ? null
        : boundedText(item.reason, `verificationResults[${index}].reason`, 2_000)
    });
  }));
}

function workspacePathList(value, label) {
  const paths = boundedList(value, label, 64);
  for (const candidate of paths) {
    const normalized = candidate.replaceAll("\\", "/");
    if (
      path.posix.isAbsolute(normalized)
      || path.win32.isAbsolute(candidate)
      || normalized.split("/").includes("..")
    ) {
      throw new TypeError(`Lane ${label} must contain workspace-relative paths.`);
    }
  }
  return paths;
}

function commitList(value) {
  const commits = boundedList(value, "commitRefs", 64);
  if (commits.some((commit) => !/^[a-f0-9]{7,64}$/iu.test(commit))) {
    throw new TypeError("Lane commitRefs must contain hexadecimal Git commit references.");
  }
  return commits;
}

function optionalText(value, label) {
  return value === null ? null : boundedText(value, label, 2_000);
}

function parseControllerRequest(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("controllerRequest must be null or a structured request.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["kind", "question"].includes(key)) || keys.length !== 2) {
    throw new TypeError("controllerRequest contains unsupported fields.");
  }
  if (!REQUEST_KINDS.includes(value.kind)) {
    throw new TypeError("controllerRequest has an unsupported request kind.");
  }
  return Object.freeze({
    kind: value.kind,
    question: boundedText(value.question, "controllerRequest.question", 2_000)
  });
}

function outcomeDiagnostic({ missing = [], unknown = [], invalid = [] } = {}) {
  return Object.freeze({
    code: "invalid_lane_outcome",
    missing: Object.freeze([...missing].sort()),
    unknown: Object.freeze([...unknown].sort()),
    invalid: Object.freeze([...invalid].filter((field) => DIAGNOSTIC_FIELDS.includes(field)).sort())
  });
}

function attachOutcomeDiagnostic(error, diagnostic) {
  Object.defineProperty(error, "outcomeDiagnostics", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: outcomeDiagnostic(diagnostic)
  });
  return error;
}

function diagnosticForError(error) {
  if (error?.outcomeDiagnostics) return error.outcomeDiagnostics;
  const message = String(error?.message ?? "").toLowerCase();
  const invalid = [...ROOT_FIELDS].filter((field) => message.includes(field.toLowerCase()));
  return outcomeDiagnostic({ invalid: invalid.length > 0 ? invalid : ["outcome"] });
}

export function parseLaneOutcome(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw attachOutcomeDiagnostic(
      new TypeError("Lane result must be valid structured outcome JSON."),
      { invalid: ["json"] }
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Lane structured outcome must be an object.");
  }
  const keys = Object.keys(value);
  const missing = [...REQUIRED_ROOT_FIELDS].filter((key) => !keys.includes(key)).sort();
  const unknown = keys.filter((key) => !ROOT_FIELDS.has(key)).sort();
  if (missing.length > 0 || unknown.length > 0) {
    const diagnostics = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
      unknown.length > 0 ? `unknown: ${unknown.join(", ")}` : null
    ].filter(Boolean).join("; ");
    throw attachOutcomeDiagnostic(
      new TypeError(`Lane structured outcome fields do not match the schema (${diagnostics}).`),
      { missing, unknown }
    );
  }
  if (!OUTCOMES.includes(value.outcome)) {
    throw new TypeError("Lane structured outcome has an unsupported outcome.");
  }
  const result = {
    outcome: value.outcome,
    summary: boundedText(value.summary, "summary", 2_000),
    workPerformed: boundedList(value.workPerformed, "workPerformed", 32),
    evidenceRefs: boundedList(value.evidenceRefs, "evidenceRefs", 64),
    artifactRefs: workspacePathList(
      value.artifactRefs === undefined ? OPTIONAL_ROOT_DEFAULTS.artifactRefs : value.artifactRefs,
      "artifactRefs"
    ),
    verification: boundedList(
      value.verification === undefined ? OPTIONAL_ROOT_DEFAULTS.verification : value.verification,
      "verification",
      32
    ),
    verificationResults: verificationResultList(
      value.verificationResults === undefined
        ? OPTIONAL_ROOT_DEFAULTS.verificationResults
        : value.verificationResults
    ),
    commitRefs: commitList(
      value.commitRefs === undefined ? OPTIONAL_ROOT_DEFAULTS.commitRefs : value.commitRefs
    ),
    configChanges: workspacePathList(
      value.configChanges === undefined ? OPTIONAL_ROOT_DEFAULTS.configChanges : value.configChanges,
      "configChanges"
    ),
    controllerRequest: parseControllerRequest(
      value.controllerRequest ?? OPTIONAL_ROOT_DEFAULTS.controllerRequest
    ),
    stopReason: optionalText(value.stopReason ?? OPTIONAL_ROOT_DEFAULTS.stopReason, "stopReason")
  };
  if (result.outcome === "accomplished" && result.controllerRequest !== null) {
    throw new TypeError("An accomplished lane cannot request controller action.");
  }
  if (result.outcome === "needs_controller" && result.controllerRequest === null) {
    throw new TypeError("A needs_controller outcome requires controllerRequest.");
  }
  if (
    result.outcome === "blocked"
    && result.stopReason === null
    && result.controllerRequest === null
  ) {
    throw new TypeError("A blocked outcome requires stopReason or controllerRequest.");
  }
  return Object.freeze(result);
}

export function hasMutationAuthority(authority = {}) {
  return authority?.sandbox === "workspace-write"
    || authority?.browser?.mutate === true
    || authority?.database?.write === true
    || authority?.image?.generate === true
    || authority?.image?.edit === true
    || Object.values(authority?.externalEffects ?? {}).some((value) => value === true);
}

function recoveryPrompt(reason) {
  return [
    "Continue in this same Codex thread and finish the admitted contract now.",
    "The existing Fleet contract already authorizes work inside its recorded authority;",
    "do not ask for redundant approval and do not widen authority.",
    reason,
    "Perform the work, verify it, and return the required structured outcome."
  ].join(" ");
}

function continuationOrController(attempts, reason, diagnostics = null) {
  if (attempts < MAX_AUTOMATIC_CONTINUATIONS) {
    return Object.freeze({ action: "continue", prompt: recoveryPrompt(reason), diagnostics });
  }
  return Object.freeze({
    action: "needs-controller",
    reason: "Codex did not produce a complete structured outcome after automatic recovery.",
    diagnostics
  });
}

function unknownOutcome(reason, result = null, diagnostics = null) {
  return Object.freeze({
    action: "outcome-unknown",
    reason: redactText(reason).slice(0, 2_000),
    result,
    diagnostics
  });
}

function reportRepair(diagnostics) {
  return Object.freeze({
    action: "repair-report",
    prompt: [
      "Your previous final Fleet report was rejected by the structured outcome schema.",
      "Do not perform more implementation, mutation, browsing, network access, or verification work.",
      "Use only the work and evidence already present in this thread and return one corrected structured outcome.",
      "Do not invent evidence or mark skipped/blocked checks as passed."
    ].join(" "),
    diagnostics
  });
}

export function decideLaneOutcome(source, attempts = 0, options = {}) {
  const mutationRisk = hasMutationAuthority(options.authority);
  let result;
  try {
    result = parseLaneOutcome(source);
  } catch (error) {
    if (mutationRisk) {
      if ((options.reportRepairAttempts ?? 0) < 1) {
        return reportRepair(diagnosticForError(error));
      }
      return unknownOutcome(
        `Mutable lane returned an invalid result; effects require reconciliation: ${error.message}`,
        null,
        diagnosticForError(error)
      );
    }
    return continuationOrController(
      attempts,
      `The prior response was invalid: ${boundedText(error.message, "error", 512)}`,
      diagnosticForError(error)
    );
  }

  const requestKind = result.controllerRequest?.kind ?? null;
  if (requestKind && CONTROLLER_ONLY_REQUESTS.has(requestKind)) {
    return Object.freeze({
      action: "needs-controller",
      reason: result.controllerRequest.question,
      result
    });
  }

  if (result.outcome === "accomplished") {
    const passedChecks = result.verificationResults.filter((item) => item.status === "passed");
    const failedChecks = result.verificationResults.filter((item) => item.status === "failed");
    if (
      result.workPerformed.length > 0
      && result.evidenceRefs.length > 0
      && (result.verification.length > 0 || passedChecks.length > 0)
      && failedChecks.length === 0
    ) {
      return Object.freeze({ action: "complete", result });
    }
    if (mutationRisk) {
      return unknownOutcome(
        "Mutable lane claimed completion without complete work, evidence, and verification references.",
        result
      );
    }
    return continuationOrController(
      attempts,
      "The prior response claimed completion without concrete work, evidence, and verification."
    );
  }

  const redundantApproval = result.outcome === "needs_controller"
    && requestKind === "redundant_approval";
  if (result.outcome === "continue_within_authority" || redundantApproval) {
    const activityWasReported = result.workPerformed.length > 0
      || result.evidenceRefs.length > 0
      || result.artifactRefs.length > 0;
    if (mutationRisk && activityWasReported) {
      return unknownOutcome(
        "Mutable lane reported partial activity before requesting continuation; effects require reconciliation.",
        result
      );
    }
    return continuationOrController(
      attempts,
      result.controllerRequest?.question
        || result.stopReason
        || "The prior turn stopped before completing the admitted work."
    );
  }

  return Object.freeze({
    action: "needs-controller",
    reason: result.controllerRequest?.question || result.stopReason || result.summary,
    result
  });
}

export function buildExecutionPrompt(prompt, options = {}) {
  const plan = options.verificationPlan;
  const lines = [prompt];
  if (plan) {
    lines.push("", "Fleet verification plan:");
    if (plan.start.length > 0) {
      lines.push("Start checks (only these may block implementation before work begins):");
      lines.push(...plan.start.map((line) => `- ${line}`));
    }
    if (plan.completion.length > 0) {
      lines.push("Completion checks (run after implementation; report sandbox/environment blockers, do not reinterpret them as start gates):");
      lines.push(...plan.completion.map((line) => `- ${line}`));
    }
    if (plan.controller.length > 0) {
      lines.push("Controller-owned checks (do not run or claim these inside the lane):");
      lines.push(...plan.controller.map((line) => `- ${line}`));
    }
  }
  if (options.includePosture !== false) {
    lines.push("", "Fleet execution posture:");
    lines.push(...executionPostureLines().map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

export function buildDeveloperInstructions(sharedContext = null) {
  return [
    "Fleet execution posture:",
    ...executionPostureLines().map((line) => `- ${line}`),
    ...(sharedContext
      ? ["", "Workspace shared context (stable across sibling lanes):", sharedContext]
      : [])
  ].join("\n");
}
