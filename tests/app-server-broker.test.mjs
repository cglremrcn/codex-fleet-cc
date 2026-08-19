import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppServerBroker,
  summarizeProtocolMessage
} from "../plugins/fleet/scripts/app-server-broker.mjs";
import { startFakeCodex } from "./fixtures/fake-codex-app-server.mjs";

test("protocol diagnostics retain shape without ids, text, errors, or secrets", () => {
  const secret = "never-retain-protocol-content";
  const summary = summarizeProtocolMessage({
    method: "turn/completed",
    params: {
      threadId: secret,
      turn: { id: secret, status: "completed", error: { message: secret } },
      item: { type: "agentMessage", text: secret }
    }
  });

  assert.deepEqual(summary, {
    kind: "notification",
    method: "turn/completed",
    turnStatus: "completed",
    itemType: "agentMessage",
    paramsKeys: ["item", "threadId", "turn"],
    turnKeys: ["error", "id", "status"],
    hasError: true
  });
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("broker close terminates its exact owned process tree", async (t) => {
  const fake = startFakeCodex(t);
  let stoppedPid = null;
  const broker = await createAppServerBroker({
    codexCommand: fake.command,
    cwd: fake.workspace,
    env: fake.env,
    captureOwnedProcess: async (pid) => ({ pid, recordedStart: "test-owned-process" }),
    stopOwnedProcessTree: async (record) => {
      stoppedPid = record.pid;
      process.kill(record.pid, "SIGTERM");
      return { cancelled: true, reason: "cancelled" };
    }
  });

  const ownedPid = broker.ownedProcess.pid;
  await broker.close();

  assert.equal(stoppedPid, ownedPid);
});
