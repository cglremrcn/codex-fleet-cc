import assert from "node:assert/strict";
import test from "node:test";

import {
  LANE_OUTCOME_SCHEMA,
  decideLaneOutcome,
  hasMutationAuthority,
  parseLaneOutcome
} from "../plugins/fleet/scripts/lib/lane-outcome.mjs";

function payload(overrides = {}) {
  return JSON.stringify({
    outcome: "accomplished",
    summary: "Implemented and verified the requested change.",
    workPerformed: ["Updated the bounded implementation."],
    evidenceRefs: ["tests/runtime.test.mjs"],
    artifactRefs: ["src/runtime.mjs"],
    verification: ["Focused tests passed."],
    controllerRequest: null,
    stopReason: null,
    ...overrides
  });
}

test("lane outcome schema is strict and requires evidence-bearing fields", () => {
  assert.equal(LANE_OUTCOME_SCHEMA.type, "object");
  assert.equal(LANE_OUTCOME_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    new Set(LANE_OUTCOME_SCHEMA.required),
    new Set([
      "outcome",
      "summary",
      "workPerformed",
      "evidenceRefs"
    ])
  );
});

test("controller outcomes normalize omitted optional evidence fields", () => {
  const result = parseLaneOutcome(JSON.stringify({
    outcome: "needs_controller",
    summary: "Build must run outside this sandbox.",
    workPerformed: ["Implemented the requested code."],
    evidenceRefs: ["tests/build.test.mjs"],
    controllerRequest: {
      kind: "runtime_blocker",
      question: "Run npm run build in the controller environment."
    }
  }));

  assert.deepEqual(result.artifactRefs, []);
  assert.deepEqual(result.verification, []);
  assert.deepEqual(result.commitRefs, []);
  assert.deepEqual(result.configChanges, []);
  assert.equal(result.stopReason, null);
});

test("schema diagnostics name missing and unknown root fields", () => {
  assert.throws(
    () => parseLaneOutcome(JSON.stringify({
      outcome: "blocked",
      summary: "Stopped.",
      workPerformed: [],
      evidenceRef: []
    })),
    /missing: evidenceRefs.*unknown: evidenceRef/iu
  );
});

test("optional commit and config evidence stays bounded and workspace-relative", () => {
  const result = parseLaneOutcome(payload({
    commitRefs: ["abcdef1", "0123456789abcdef0123456789abcdef01234567"],
    configChanges: [".github/workflows/release.yml"]
  }));
  assert.deepEqual(result.commitRefs, ["abcdef1", "0123456789abcdef0123456789abcdef01234567"]);
  assert.deepEqual(result.configChanges, [".github/workflows/release.yml"]);

  assert.throws(() => parseLaneOutcome(payload({ commitRefs: ["not-a-commit"] })), /commit/iu);
  assert.throws(() => parseLaneOutcome(payload({ configChanges: ["../outside.env"] })), /config/iu);
});

test("blocked outcomes may identify a controller request instead of a stop reason", () => {
  const result = parseLaneOutcome(payload({
    outcome: "blocked",
    controllerRequest: {
      kind: "missing_input",
      question: "Provide the missing deployment target."
    },
    stopReason: null
  }));
  assert.equal(result.controllerRequest.kind, "missing_input");
  assert.equal(result.stopReason, null);
});

test("accomplished requires concrete work and verification before complete", () => {
  const complete = decideLaneOutcome(payload(), 0);
  assert.equal(complete.action, "complete");
  assert.equal(complete.result.summary, "Implemented and verified the requested change.");

  const incomplete = decideLaneOutcome(payload({
    workPerformed: [],
    evidenceRefs: [],
    verification: []
  }), 0);
  assert.equal(incomplete.action, "continue");
  assert.match(incomplete.prompt, /perform the work.*verify/isu);
});

test("redundant approval requests continue automatically in the same authority", () => {
  const decision = decideLaneOutcome(payload({
    outcome: "needs_controller",
    workPerformed: [],
    evidenceRefs: [],
    verification: [],
    artifactRefs: [],
    controllerRequest: {
      kind: "redundant_approval",
      question: "Say continue before I edit files."
    }
  }), 0, { authority: { sandbox: "workspace-write" } });

  assert.equal(decision.action, "continue");
  assert.match(decision.prompt, /already authorizes/iu);
});

test("new authority returns to the controller without silently widening scope", () => {
  const decision = decideLaneOutcome(payload({
    outcome: "needs_controller",
    workPerformed: [],
    evidenceRefs: [],
    verification: [],
    artifactRefs: [],
    controllerRequest: {
      kind: "new_authority",
      question: "Production deploy permission is required."
    }
  }), 0);

  assert.equal(decision.action, "needs-controller");
  assert.match(decision.reason, /Production deploy permission/);
});

test("malformed or repeatedly incomplete outcomes never become complete", () => {
  assert.equal(decideLaneOutcome("not json", 0).action, "continue");
  const exhausted = decideLaneOutcome("not json", 2);
  assert.equal(exhausted.action, "needs-controller");
  assert.match(exhausted.reason, /structured outcome/iu);
});

test("ambiguous mutable results become unknown instead of automatic retries", () => {
  const mutationAuthorities = [
    { sandbox: "workspace-write" },
    { sandbox: "read-only", browser: { mutate: true } },
    { sandbox: "read-only", database: { write: true } },
    { sandbox: "read-only", image: { generate: true } },
    { sandbox: "read-only", image: { edit: true } },
    { sandbox: "read-only", externalEffects: { send: true } },
    { sandbox: "read-only", externalEffects: { payment: true } },
    { sandbox: "read-only", externalEffects: { deploy: true } },
    { sandbox: "read-only", externalEffects: { delete: true } }
  ];

  for (const authority of mutationAuthorities) {
    assert.equal(hasMutationAuthority(authority), true);
    assert.equal(
      decideLaneOutcome("not json", 0, { authority }).action,
      "outcome-unknown"
    );
    assert.equal(
      decideLaneOutcome(payload({ evidenceRefs: [] }), 0, { authority }).action,
      "outcome-unknown"
    );
  }
});

test("controller-only requests take precedence over contradictory continuation outcomes", () => {
  for (const kind of [
    "new_authority",
    "external_effect",
    "missing_input",
    "user_choice",
    "runtime_blocker"
  ]) {
    const decision = decideLaneOutcome(payload({
      outcome: "continue_within_authority",
      workPerformed: [],
      evidenceRefs: [],
      verification: [],
      artifactRefs: [],
      controllerRequest: { kind, question: `Controller must resolve ${kind}.` }
    }), 0);
    assert.equal(decision.action, "needs-controller", kind);
  }

  const blockedApproval = decideLaneOutcome(payload({
    outcome: "blocked",
    workPerformed: [],
    evidenceRefs: [],
    verification: [],
    artifactRefs: [],
    controllerRequest: { kind: "redundant_approval", question: "Say continue." },
    stopReason: "The lane stopped."
  }), 0);
  assert.equal(blockedApproval.action, "needs-controller");
});

test("artifact references are bounded workspace-relative paths", () => {
  assert.throws(() => parseLaneOutcome(payload({ artifactRefs: ["../secret.txt"] })), /artifact/iu);
  assert.throws(() => parseLaneOutcome(payload({ artifactRefs: ["C:\\secret.txt"] })), /artifact/iu);
});
