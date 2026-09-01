export const MAX_PERSISTED_TEXT = 8192;

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "systemprompt",
  "reasoning",
  "chainofthought",
  "cookie",
  "cookies",
  "secret",
  "secrets",
  "rawoutput",
  "commandoutput",
  "fulloutput",
  "stdout",
  "stderr",
  "authorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "sessioncookie",
  "credential",
  "credentials",
  "privatekey"
]);

const REDACTIONS = Object.freeze([
  [/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?/gi, "[REDACTED:PATH]"],
  [/(?:\/Users|\/home)\/[^/\s]+(?:\/[^\s]*)?/g, "[REDACTED:PATH]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED:TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "[REDACTED:TOKEN]"],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, "[REDACTED:TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:TOKEN]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:EMAIL]"],
  [
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\s*[:=]\s*[^\s,;]+/gi,
    "[REDACTED:SECRET]"
  ]
]);

export function redactText(input) {
  const text = typeof input === "string" ? input : String(input ?? "");
  const omitted = Math.max(0, text.length - MAX_PERSISTED_TEXT);
  let safe = text.slice(0, MAX_PERSISTED_TEXT);

  for (const [pattern, replacement] of REDACTIONS) {
    safe = safe.replace(pattern, replacement);
  }

  return omitted > 0 ? `${safe}[TRUNCATED:${omitted}]` : safe;
}

function sanitizeValue(value, seen) {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (seen.has(value)) {
    return "[REDACTED:CYCLE]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, 256).map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      continue;
    }
    const sanitized = sanitizeValue(item, seen);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  seen.delete(value);
  return result;
}

export function sanitizeLaneForPersistence(lane) {
  if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
    throw new TypeError("Lane metadata must be an object.");
  }
  const sanitized = sanitizeValue(lane, new WeakSet());
  const boundedEvidence = (value, maximumItems, maximumLength = 512) => (
    Array.isArray(value)
      ? value
        .slice(0, maximumItems)
        .filter((item) => typeof item === "string" && !/[\u0000-\u001f\u007f]/u.test(item))
        .map((item) => redactText(item).slice(0, maximumLength))
      : []
  );

  sanitized.commitRefs = boundedEvidence(lane.commitRefs, 64, 64);
  sanitized.configChanges = boundedEvidence(lane.configChanges, 64, 256);
  if (lane.outcomeDiagnostics && typeof lane.outcomeDiagnostics === "object") {
    sanitized.outcomeDiagnostics = {
      code: "invalid_lane_outcome",
      missing: boundedEvidence(lane.outcomeDiagnostics.missing, 32, 128),
      unknown: boundedEvidence(lane.outcomeDiagnostics.unknown, 32, 128),
      invalid: boundedEvidence(lane.outcomeDiagnostics.invalid, 32, 128)
    };
  } else {
    sanitized.outcomeDiagnostics = null;
  }
  return sanitized;
}
