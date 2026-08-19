import assert from "node:assert/strict";
import test from "node:test";

import { renderPlainStatus } from "../plugins/fleet/scripts/lib/plain-status.mjs";

test("plain status is linear and free of cursor-control codes", () => {
  const output = renderPlainStatus({
    workspace: { name: "fleet-demo", branch: "main" },
    runtime: { health: "ready", protocol: "compatible" },
    lanes: [
      { id: "inspect", role: "investigator", status: "complete", label: "Inspect runtime" },
      { id: "build", role: "implementer", status: "running", label: "Build console" },
      { id: "verify", role: "independent-verifier", status: "verified", label: "Verify result" }
    ]
  });

  assert.doesNotMatch(output, /\u001b\[/);
  assert.match(output, /Fleet workspace fleet-demo, branch main/);
  assert.match(output, /Lane 1 of 3: inspect, complete, investigator, Inspect runtime/);
  assert.match(output, /Lane 3 of 3: verify, verified/);
});

test("plain status bounds hostile fields and remains useful with no lanes", () => {
  const hostile = "x".repeat(10_000);
  const output = renderPlainStatus({
    workspace: { name: hostile, branch: "main\u001b[31m" },
    runtime: { health: "unknown", protocol: "unknown" },
    lanes: []
  });

  assert.ok(output.length < 2_000);
  assert.doesNotMatch(output, /\u001b\[/);
  assert.match(output, /No Fleet lanes recorded/);
});

test("plain status exposes recovery, controller action, and uncertain continuations", () => {
  const output = renderPlainStatus({
    workspace: { name: "fleet-demo", branch: "main" },
    runtime: { health: "ready", protocol: "compatible" },
    lanes: [
      {
        id: "recovering",
        role: "implementer",
        status: "running",
        phase: "recovering 1/2",
        label: "Continue safe work",
        automaticContinuations: 1
      },
      {
        id: "authority",
        role: "implementer",
        status: "blocked",
        label: "Deploy release",
        controllerRequest: {
          kind: "new_authority",
          question: "Deployment authority is required."
        }
      },
      {
        id: "uncertain",
        role: "implementer",
        status: "complete",
        label: "Preserve terminal result",
        pendingContinuation: { state: "outcome_unknown", previousTurnId: "turn-1" }
      }
    ]
  });

  assert.match(output, /RECOVERING 1\/2/iu);
  assert.match(output, /CLAUDE ACTION \[new_authority\]: Deployment authority is required\./iu);
  assert.match(output, /CONTINUATION OUTCOME UNKNOWN/iu);
});

test("plain status does not label a completed recovery attempt as currently recovering", () => {
  const output = renderPlainStatus({
    workspace: { name: "fleet-demo", branch: "main" },
    runtime: { health: "ready", protocol: "compatible" },
    lanes: [{
      id: "done-after-recovery",
      role: "implementer",
      status: "complete",
      phase: "complete",
      label: "Completed after one bounded recovery",
      automaticContinuations: 1
    }]
  });

  assert.doesNotMatch(output, /RECOVERING/iu);
});
