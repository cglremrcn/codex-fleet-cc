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
