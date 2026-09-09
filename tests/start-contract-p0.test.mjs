import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { validateStartContract } from "../plugins/fleet/scripts/lib/start-contract.mjs";

const workspacePath = path.resolve(".");
function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    workspacePath,
    lanes: [{
      id: "lane-a",
      role: "investigator",
      label: "Inspect bounded surface",
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "Inspect and report evidence.",
      authority: { process: { start: true } }
    }],
    ...overrides
  };
}

test("shared context and verification phases are bounded first-class contract fields", () => {
  const result = validateStartContract(contract({
    sharedContext: "Stable repository constraints shared by sibling lanes.",
    lanes: [{
      ...contract().lanes[0],
      verificationPlan: {
        start: ["Required source files exist."],
        completion: ["Focused unit tests pass."],
        controller: ["Production database migration smoke." ]
      }
    }]
  }));
  assert.match(result.sharedContext, /Stable repository/);
  assert.deepEqual(result.lanes[0].verificationPlan.start, ["Required source files exist."]);
  assert.deepEqual(result.lanes[0].verificationPlan.completion, ["Focused unit tests pass."]);
  assert.deepEqual(result.lanes[0].verificationPlan.controller, ["Production database migration smoke."]);
});

test("lane-local modelPolicy error points to the correct root location", () => {
  assert.throws(
    () => validateStartContract(contract({
      lanes: [{ ...contract().lanes[0], modelPolicy: "runtime" }]
    })),
    /modelPolicy belongs at the contract root as \$\.modelPolicy/iu
  );
});

test("qualified retry lineage can cross worktree ledgers without pretending local reconciliation", () => {
  const result = validateStartContract(contract({
    lanes: [{
      ...contract().lanes[0],
      retryOf: "0123456789abcdef0123456789abcdef:source-lane"
    }]
  }));
  assert.equal(result.lanes[0].retryOf, "0123456789abcdef0123456789abcdef:source-lane");
});
