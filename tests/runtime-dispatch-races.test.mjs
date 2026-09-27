import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { FleetRuntime } from "../plugins/fleet/scripts/lib/runtime-adapter.mjs";

test("report repair cannot dispatch a third writable turn", async () => {
  const policies = [];
  const broker = { protocolVersion: 1, setEventHandler() {}, async close() {},
    async request(method, params) {
      if (method === "thread/start") return { thread: { id: "thread-a" } };
      if (method === "command/exec") return { exitCode: 0, stdout: "" };
      if (method === "turn/start") {
        policies.push(params.sandboxPolicy.type);
        return { turn: { id: `turn-${policies.length}` } };
      }
      return {};
    }
  };
  const runtime = new FleetRuntime(broker);
  await runtime.startLane({ id: "lane-a", label: "Implement", role: "implementer",
    model: "gpt-5.6-sol", effort: "high", workspaceKey: "a".repeat(32),
    workspacePath: path.resolve("."), prompt: "Inspect fixture",
    authority: { sandbox: "workspace-write" } });
  runtime.handleNotification({ method: "turn/completed", params: {
    threadId: "thread-a", turn: { id: "turn-1", status: "completed" }
  } });
  await new Promise(resolve => setImmediate(resolve));
  runtime.handleNotification({ method: "item/completed", params: {
    threadId: "thread-a", turnId: "turn-2", item: { type: "agentMessage",
      text: JSON.stringify({ outcome: "continue_within_authority", summary: "More edits needed",
        workPerformed: [], evidenceRefs: [] }) }
  } });
  runtime.handleNotification({ method: "turn/completed", params: {
    threadId: "thread-a", turn: { id: "turn-2", status: "completed" }
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(policies, ["workspaceWrite", "readOnly"]);
  assert.equal(runtime.inspectLane("lane-a").status, "outcome_unknown");
});

test("a delayed start acknowledgement cannot replace its automatic continuation", async () => {
  let runtime;
  let turns = 0;
  const broker = {
    protocolVersion: 1, setEventHandler() {}, async close() {},
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-a" } };
      if (method !== "turn/start") return {};
      const id = `turn-${++turns}`;
      if (turns === 1) {
        runtime.handleNotification({ method: "turn/started",
          params: { threadId: "thread-a", turn: { id } } });
        // A missing structured result legitimately triggers read-only automatic recovery.
        runtime.handleNotification({ method: "turn/completed",
          params: { threadId: "thread-a", turn: { id, status: "completed" } } });
        await new Promise(resolve => setImmediate(resolve));
      }
      return { turn: { id } };
    }
  };
  runtime = new FleetRuntime(broker);
  await runtime.startLane({ id: "lane-a", label: "Inspect", role: "investigator",
    model: "gpt-5.6-sol", effort: "high", workspaceKey: "a".repeat(32),
    workspacePath: path.resolve("."), prompt: "Inspect fixture",
    authority: { sandbox: "read-only" } });
  assert.equal(turns, 2);
  assert.equal(runtime.inspectLane("lane-a").turnId, "turn-2");
  runtime.handleNotification({ method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn-2", status: "interrupted" } } });
  assert.equal(runtime.inspectLane("lane-a").status, "cancelled");
});
