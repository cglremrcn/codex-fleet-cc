import assert from "node:assert/strict";
import test from "node:test";

import {
  createOriginalEditor,
  createSupervisorRuntime,
  runEntry
} from "../plugins/fleet/scripts/fleet-console.mjs";

test("plain startup benchmark exits cleanly with machine-readable timing", async () => {
  const writes = [];
  let time = 10;
  const exitCode = await runEntry(["--benchmark-startup", "--plain"], {
    stdout: { write: (value) => writes.push(String(value)) },
    now: () => {
      time += 4;
      return time;
    }
  });

  assert.equal(exitCode, 0);
  const result = JSON.parse(writes.join(""));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.startupMs, 4);
  assert.equal(result.backgroundProcesses, 0);
});

test("entry rejects unknown flags without opening a terminal", async () => {
  const errors = [];
  const exitCode = await runEntry(["--mystery"], {
    stderr: { write: (value) => errors.push(String(value)) }
  });

  assert.equal(exitCode, 2);
  assert.match(errors.join(""), /Unknown Fleet Console argument/);
});

test("a launcher without a prior editor disables editor handoff", () => {
  assert.equal(createOriginalEditor({ FLEET_ORIGINAL_EDITOR_JSON: "null" }), undefined);
});

test("console runtime follows up and confirms only the pinned cancel preview", async () => {
  const requests = [];
  const manifest = {
    address: "\\\\.\\pipe\\fleet-test",
    token: "a".repeat(64)
  };
  const runtime = await createSupervisorRuntime({
    cwd: process.cwd(),
    env: process.env,
    ensureSupervisor: async () => manifest,
    requestSupervisor: async (request) => {
      requests.push(request);
      if (request.method === "cancel" && !request.params.confirmationToken) {
        return {
          expectedThreadId: "thread-a",
          expectedTurnId: "turn-a",
          confirmationToken: "b".repeat(64)
        };
      }
      return { accepted: true };
    }
  });
  const lane = { id: "lane-a", threadId: "thread-a", turnId: "turn-a" };

  await runtime.followUp(lane, "Inspect the second surface.");
  await runtime.cancel(lane, { threadId: "thread-a", turnId: "turn-a" });

  assert.deepEqual(requests.map((request) => request.method), [
    "followUp",
    "cancel",
    "cancel"
  ]);
  assert.deepEqual(requests[2].params, {
    laneId: "lane-a",
    expectedThreadId: "thread-a",
    expectedTurnId: "turn-a",
    confirmationToken: "b".repeat(64)
  });
});
