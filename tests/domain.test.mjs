import assert from "node:assert/strict";
import test from "node:test";

import {
  LANE_STATUSES,
  TERMINAL_STATUSES,
  createLane,
  isTerminalStatus,
  transitionLane
} from "../plugins/fleet/scripts/lib/domain.mjs";

const NOW = "2026-08-17T12:00:00.000Z";

function fixtureLane(overrides = {}) {
  return {
    id: "investigator-1",
    role: "investigator",
    label: "Inspect the runtime boundary",
    workspaceKey: "0123456789abcdef0123456789abcdef",
    model: "gpt-5.6-sol",
    effort: "high",
    authority: { sandbox: "read-only", network: "off" },
    createdAt: NOW,
    ...overrides
  };
}

test("new lanes start queued with immutable input", () => {
  const input = fixtureLane();
  const lane = createLane(input);

  assert.equal(lane.status, "queued");
  assert.equal(lane.phase, "queued");
  assert.equal(lane.createdAt, NOW);
  assert.equal(Object.isFrozen(lane), true);
  assert.equal(Object.isFrozen(lane.authority), true);
  assert.notEqual(lane.authority, input.authority);
});

test("complete remains a claim until independent evidence verifies it", () => {
  const lane = createLane(fixtureLane());
  const running = transitionLane(lane, "running", { at: NOW });
  const complete = transitionLane(running, "complete", {
    at: NOW,
    resultRef: "results/investigator-1.json"
  });

  assert.equal(complete.status, "complete");
  assert.throws(
    () => transitionLane(complete, "verified", { at: NOW }),
    /verification evidence/i
  );

  const verified = transitionLane(complete, "verified", {
    at: NOW,
    verifierLaneId: "verifier-1",
    evidenceRefs: ["evidence/verification.json"]
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.verifierLaneId, "verifier-1");
});

test("a lane cannot verify its own result", () => {
  const running = transitionLane(createLane(fixtureLane()), "running", { at: NOW });
  const complete = transitionLane(running, "complete", {
    at: NOW,
    resultRef: "results/investigator-1.json"
  });

  assert.throws(
    () => transitionLane(complete, "verified", {
      at: NOW,
      verifierLaneId: complete.id,
      evidenceRefs: ["evidence/self-check.json"]
    }),
    /independent verifier/i
  );
});

test("unknown external outcome cannot be queued before reconciliation", () => {
  const running = transitionLane(createLane(fixtureLane()), "running", { at: NOW });
  const unknown = transitionLane(running, "outcome_unknown", {
    at: NOW,
    externalEffect: true
  });

  assert.throws(
    () => transitionLane(unknown, "queued", { at: NOW }),
    /reconciliation/i
  );

  const reconciled = transitionLane(unknown, "queued", {
    at: NOW,
    reconciliationRef: "evidence/provider-status.json"
  });
  assert.equal(reconciled.status, "queued");
  assert.equal(reconciled.reconciliationRef, "evidence/provider-status.json");
});

test("illegal transitions and incomplete completion evidence fail closed", () => {
  const lane = createLane(fixtureLane());

  assert.throws(() => transitionLane(lane, "verified", { at: NOW }), /transition/i);
  assert.throws(
    () => transitionLane(transitionLane(lane, "running", { at: NOW }), "complete", { at: NOW }),
    /result reference/i
  );
  assert.throws(() => transitionLane(lane, "made_up", { at: NOW }), /unknown lane status/i);
});

test("status constants and terminal classification stay aligned", () => {
  assert.deepEqual(LANE_STATUSES, [
    "queued",
    "running",
    "complete",
    "verified",
    "blocked",
    "failed",
    "cancelled",
    "interrupted",
    "outcome_unknown"
  ]);
  assert.deepEqual(TERMINAL_STATUSES, [
    "complete",
    "verified",
    "blocked",
    "failed",
    "cancelled",
    "interrupted",
    "outcome_unknown"
  ]);
  assert.equal(isTerminalStatus("interrupted"), true);
  assert.equal(isTerminalStatus("verified"), true);
  assert.equal(isTerminalStatus("running"), false);
  assert.equal(isTerminalStatus("made_up"), false);
});

test("interrupted is terminal and cannot be automatically requeued", () => {
  const running = transitionLane(createLane(fixtureLane()), "running", { at: NOW });
  const interrupted = transitionLane(running, "interrupted", { at: NOW });

  assert.equal(interrupted.status, "interrupted");
  assert.throws(
    () => transitionLane(interrupted, "queued", { at: NOW }),
    /transition/iu
  );
});

test("lane contracts reject malformed and oversized identity fields", () => {
  assert.throws(() => createLane(fixtureLane({ id: "bad id" })), /lane id/i);
  assert.throws(() => createLane(fixtureLane({ role: "supreme-overlord" })), /lane role/i);
  assert.throws(() => createLane(fixtureLane({ label: "x".repeat(121) })), /lane label/i);
  assert.throws(() => createLane(fixtureLane({ workspaceKey: "private/path" })), /workspace key/i);
});
