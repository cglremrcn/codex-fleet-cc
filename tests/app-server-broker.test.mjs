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

test("broker close first lets app-server exit naturally on stdin EOF", async (t) => {
  const fake = startFakeCodex(t);
  let stopCalls = 0;
  const broker = await createAppServerBroker({
    codexCommand: fake.command,
    cwd: fake.workspace,
    env: fake.env,
    gracefulCloseMs: 1_000,
    stopOwnedProcessTree: async () => {
      stopCalls += 1;
      return { cancelled: false, reason: "stop-failed" };
    }
  });

  await broker.close();

  assert.equal(stopCalls, 0);
});

test("broker close terminates its exact owned process tree after graceful timeout", async (t) => {
  const fake = startFakeCodex(t, "stubborn-stdin-close");
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

test("broker refusal releases local handles and reports safe ownership metadata", async (t) => {
  const fake = startFakeCodex(t, "stubborn-stdin-close");
  const broker = await createAppServerBroker({
    codexCommand: fake.command,
    cwd: fake.workspace,
    env: fake.env,
    gracefulCloseMs: 10,
    captureOwnedProcess: async (pid) => ({ pid, recordedStart: "recorded-start" }),
    stopOwnedProcessTree: async () => ({
      cancelled: false,
      reason: "ownership-mismatch"
    })
  });
  const ownedPid = broker.ownedProcess.pid;

  await assert.rejects(broker.close(), (error) => {
    assert.equal(error.code, "FLEET_BROKER_OWNERSHIP_REFUSED");
    assert.deepEqual(error.diagnostic, {
      reasonCode: "ownership-mismatch",
      action: "not_stopped",
      pid: ownedPid,
      recordedIdentityPresent: true,
      currentIdentity: "different",
      remediation: "Re-run doctor; inspect the process through normal OS or app controls."
    });
    return true;
  });

  assert.equal(broker.child.stdin.destroyed, true);
  assert.equal(broker.child.stdout.destroyed, true);
  assert.equal(broker.child.stderr.destroyed, true);
  broker.child.ref();
  process.kill(ownedPid, "SIGTERM");
  await broker.exitPromise;
});

test("broker marks a timed-out post-send request as acceptance unknown", async (t) => {
  const fake = startFakeCodex(t, "accept-turn-without-response");
  const broker = await createAppServerBroker({
    codexCommand: fake.command,
    cwd: fake.workspace,
    env: fake.env,
    requestTimeoutMs: 50
  });
  try {
    const thread = await broker.request("thread/start", {
      cwd: fake.workspace,
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "codex_fleet_cc",
      ephemeral: true
    });

    await assert.rejects(
      broker.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: "Run once.", text_elements: [] }]
      }),
      (error) => {
        assert.equal(error.requestAcceptance, "unknown");
        assert.match(error.message, /timed out.*turn\/start/iu);
        return true;
      }
    );
    assert.equal(fake.readState().threads[0].turns.length, 1);
  } finally {
    await broker.close();
  }
});

test("broker preserves exact argv for sandboxed command execution", async (t) => {
  const fake = startFakeCodex(t);
  const broker = await createAppServerBroker({
    codexCommand: fake.command,
    cwd: fake.workspace,
    env: fake.env
  });
  try {
    const command = [process.execPath, "-e", "process.stdout.write(process.version)"];
    const sandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [fake.workspace],
      networkAccess: false
    };
    const result = await broker.request("command/exec", {
      command,
      cwd: fake.workspace,
      sandboxPolicy,
      timeoutMs: 10_000
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.readState().lastCommandExec.command, command);
    assert.deepEqual(fake.readState().lastCommandExec.sandboxPolicy, sandboxPolicy);
  } finally {
    await broker.close();
  }
});
