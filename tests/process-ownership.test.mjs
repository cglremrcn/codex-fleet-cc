import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelOwnedProcess,
  captureOwnedProcess,
  observeProcessStart
} from "../plugins/fleet/scripts/lib/process-ownership.mjs";
import { stopOwnedProcessTree } from "../plugins/fleet/scripts/app-server-broker.mjs";

test("cancel refuses a reused PID whose process-start identity differs", async () => {
  const killed = [];
  const result = await cancelOwnedProcess({ pid: 4242, recordedStart: "start-a" }, {
    observeStart: async () => "start-b",
    kill: (pid, signal) => killed.push({ pid, signal })
  });

  assert.deepEqual(result, { cancelled: false, reason: "ownership-mismatch" });
  assert.deepEqual(killed, []);
});

test("cancel stops only a process whose current identity matches the record", async () => {
  const killed = [];
  const result = await cancelOwnedProcess({ pid: 4242, recordedStart: "start-a" }, {
    observeStart: async () => "start-a",
    kill: (pid, signal) => killed.push({ pid, signal })
  });

  assert.deepEqual(result, { cancelled: true, reason: "owned-process-stopped" });
  assert.deepEqual(killed, [{ pid: 4242, signal: "SIGTERM" }]);
});

test("capture records an observed start identity and rejects missing processes", async () => {
  assert.deepEqual(
    await captureOwnedProcess(77, { observeStart: async () => "identity-77" }),
    { pid: 77, recordedStart: "identity-77" }
  );
  await assert.rejects(
    captureOwnedProcess(78, { observeStart: async () => null }),
    /not running/i
  );
});

test("invalid process records fail closed without observing or killing", async () => {
  let observed = false;
  let killed = false;
  const result = await cancelOwnedProcess({ pid: -1, recordedStart: "x" }, {
    observeStart: async () => {
      observed = true;
      return "x";
    },
    kill: () => {
      killed = true;
    }
  });

  assert.deepEqual(result, { cancelled: false, reason: "invalid-record" });
  assert.equal(observed, false);
  assert.equal(killed, false);
});

test("Windows observer captures the current process without shell interpolation", {
  skip: process.platform !== "win32"
}, async () => {
  const identity = await observeProcessStart(process.pid);

  assert.match(identity, /^win32:\d+$/u);
});

test("broker tree cleanup verifies process identity before terminating", async () => {
  const terminated = [];
  const options = {
    observeStart: async () => "start-a",
    terminateProcessTree: (pid) => {
      terminated.push(pid);
      return { attempted: true, delivered: true, method: "test" };
    }
  };

  assert.deepEqual(
    await stopOwnedProcessTree({ pid: 4242, recordedStart: "start-a" }, options),
    { cancelled: true, reason: "owned-process-stopped" }
  );
  assert.deepEqual(terminated, [4242]);

  assert.deepEqual(
    await stopOwnedProcessTree(
      { pid: 4242, recordedStart: "start-b" },
      options
    ),
    { cancelled: false, reason: "ownership-mismatch" }
  );
  assert.deepEqual(terminated, [4242]);
});
