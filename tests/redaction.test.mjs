import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PERSISTED_TEXT,
  redactText,
  sanitizeLaneForPersistence
} from "../plugins/fleet/scripts/lib/redaction.mjs";

test("redaction removes credentials, email addresses, and private home paths", () => {
  const value = redactText(
    "Bearer abc.def.ghi user@example.com sk-live-secret " +
      "github_pat_11AAsecret C:\\Users\\Ada\\client /Users/ada/client"
  );

  assert.doesNotMatch(
    value,
    /abc\.def\.ghi|user@example\.com|sk-live-secret|github_pat_11AAsecret|Users\\Ada|Users\/ada/i
  );
  assert.match(value, /\[REDACTED:TOKEN\]/);
  assert.match(value, /\[REDACTED:EMAIL\]/);
  assert.match(value, /\[REDACTED:PATH\]/);
});

test("redaction bounds text before it reaches terminal or disk", () => {
  const value = redactText("x".repeat(MAX_PERSISTED_TEXT + 500));

  assert.ok(value.length <= MAX_PERSISTED_TEXT + 32);
  assert.match(value, /\[TRUNCATED:500\]$/);
});

test("lane sanitization removes prompts, reasoning, cookies, and raw output recursively", () => {
  const sanitized = sanitizeLaneForPersistence({
    id: "lane-1",
    label: "Email user@example.com",
    prompt: "private prompt",
    reasoning: "hidden chain",
    rawOutput: "large output",
    tokenUsage: { input: 10, output: 5 },
    progressSummary: "Bearer abc.def.ghi",
    nested: {
      cookies: "session_cookie=secret",
      safe: "visible"
    }
  });
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(serialized, /private prompt|hidden chain|large output|session_cookie|abc\.def/);
  assert.equal(sanitized.tokenUsage.input, 10);
  assert.equal(sanitized.nested.safe, "visible");
  assert.match(sanitized.label, /\[REDACTED:EMAIL\]/);
});

test("lane sanitization does not mutate its source object", () => {
  const source = { label: "user@example.com", nested: { safe: "keep" } };
  const sanitized = sanitizeLaneForPersistence(source);

  assert.equal(source.label, "user@example.com");
  assert.notEqual(sanitized, source);
  assert.notEqual(sanitized.nested, source.nested);
});

test("lane sanitization bounds evidence arrays and allowlists outcome diagnostics", () => {
  const sanitized = sanitizeLaneForPersistence({
    id: "lane-evidence",
    commitRefs: ["deadbee", ...Array.from({ length: 80 }, () => "abcdef1")],
    configChanges: ["config/app.json", "Bearer abc.def.ghi"],
    outcomeDiagnostics: {
      code: "invalid_lane_outcome",
      missing: ["evidenceRefs"],
      unknown: ["evidenceRef"],
      invalid: ["commitRefs:deadbee"],
      rawOutput: "do not persist",
      nested: { secret: "do not persist" }
    }
  });

  assert.equal(sanitized.commitRefs.length, 64);
  assert.deepEqual(sanitized.configChanges, ["config/app.json", "Bearer [REDACTED:TOKEN]"]);
  assert.deepEqual(sanitized.outcomeDiagnostics, {
    code: "invalid_lane_outcome",
    missing: ["evidenceRefs"],
    unknown: ["evidenceRef"],
    invalid: ["commitRefs:deadbee"]
  });
});
