import assert from "node:assert/strict";
import test from "node:test";

import {
  renderPlainStatus,
  selectStatusLanes
} from "../plugins/fleet/scripts/lib/plain-status.mjs";

function largeLaneSet() {
  const lanes = Array.from({ length: 57 }, (_, index) => ({
    id: `unknown-${String(index + 1).padStart(2, "0")}`,
    role: "investigator",
    status: "outcome_unknown",
    label: `Old uncertain lane ${index + 1}`,
    finishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  lanes.push({
    id: "current-running",
    role: "implementer",
    status: "running",
    label: "Current active lane",
    startedAt: "2026-09-01T10:00:00.000Z"
  });
  return lanes;
}

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

test("status selection keeps active work visible and reports omitted statuses", () => {
  const selection = selectStatusLanes(largeLaneSet(), { limit: 32 });
  const output = renderPlainStatus({
    workspace: { name: "fleet-demo", branch: "main" },
    runtime: { health: "ready", protocol: "compatible" },
    lanes: selection.lanes,
    selection
  });

  assert.equal(selection.total, 58);
  assert.equal(selection.shown, 32);
  assert.equal(selection.lanes[0].id, "current-running");
  assert.deepEqual(selection.omittedByStatus, { outcome_unknown: 26 });
  assert.match(output, /Showing 32\/58 lanes/iu);
  assert.match(output, /current-running/iu);
  assert.match(output, /Omitted by status: outcome_unknown=26/iu);
});

test("status selection filters before limiting and uses deterministic attention order", () => {
  const lanes = largeLaneSet();
  lanes.push({
    id: "blocked-new",
    role: "implementer",
    status: "blocked",
    label: "Needs authority",
    finishedAt: "2026-09-01T11:00:00.000Z"
  });
  const selection = selectStatusLanes(lanes, {
    statuses: ["running", "blocked"],
    sinceMs: Date.parse("2026-09-01T09:00:00.000Z"),
    limit: 1
  });

  assert.equal(selection.matching, 2);
  assert.equal(selection.lanes[0].id, "current-running");
  assert.deepEqual(selection.omittedByStatus, { blocked: 1 });
});
