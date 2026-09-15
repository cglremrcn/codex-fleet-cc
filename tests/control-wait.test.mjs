import assert from "node:assert/strict";
import test from "node:test";
import { createControlWait } from "../plugins/fleet/scripts/lib/control-wait.mjs";
import { createObservationFeed } from "../plugins/fleet/scripts/lib/control-observation.mjs";
const KEY = "a".repeat(32);
const idle = { lanes: [] };
const active = { lanes: [{ id: "worker", status: "running" }] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, snapshot) {
  const feed = createObservationFeed({ workspaceKey: KEY });
  const waiter = createControlWait({ feed, snapshot, intervalMs: 5, maxWaiters: 2 });
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => { clearTimeout(keepAlive); waiter.dispose(); feed.dispose(); });
  return { feed, waiter };
}

test("cursor closes observe/wait lost-wakeup even when another lane is still running", async t => {
  const changed = { lanes: [{ id: "worker", status: "complete" }, { id: "other", status: "running" }] };
  const { feed, waiter } = fixture(t, async () => changed);
  const initial = feed.observe(active).cursor;
  const result = await waiter.wait({ cursor: initial, timeoutMs: 100 });
  assert.equal(result.changed, true); assert.equal(result.reason, "state-changed");
});

test("wait timeout is not completion or failure and ignores timestamp-only noise", async t => {
  const { feed, waiter } = fixture(t, async () => ({ ...active, updatedAt: new Date().toISOString() }));
  const result = await waiter.wait({ cursor: feed.observe(active).cursor, timeoutMs: 20 });
  assert.equal(result.changed, false); assert.equal(result.timedOut, true); assert.equal(result.reason, "timeout");
});

test("one unresolved snapshot read remains single-flight beyond multiple waiter deadlines", async t => {
  const deferredRead = deferred(); let calls = 0;
  const { waiter } = fixture(t, () => { calls++; return deferredRead.promise; });
  assert.equal((await waiter.wait({ timeoutMs: 12 })).timedOut, true);
  assert.equal((await waiter.wait({ timeoutMs: 12 })).timedOut, true);
  assert.equal(calls, 1); deferredRead.resolve(idle); await sleep(1);
});

test("waiter bounds and close do not leak or start a replacement read", async t => {
  const deferredRead = deferred(); const { waiter } = fixture(t, () => deferredRead.promise);
  const first = waiter.wait({ timeoutMs: 500 }).catch(error => error);
  const second = waiter.wait({ timeoutMs: 500 }).catch(error => error);
  await assert.rejects(waiter.wait({ timeoutMs: 500 }), { code: "CONTROL_WAIT_LIMIT" });
  waiter.dispose(); assert.equal((await first).code, "CONTROL_CLOSED"); assert.equal((await second).code, "CONTROL_CLOSED");
  deferredRead.resolve(active); await sleep(1); assert.equal(waiter.stats().waiters, 0);
});

test("idle, invalid cursor, changed usage projection and restart have explicit outcomes", async t => {
  const { waiter, feed } = fixture(t, () => idle);
  assert.equal((await waiter.wait({ timeoutMs: 20 })).reason, "idle");
  await assert.rejects(waiter.wait({ cursor: "invalid", timeoutMs: 20 }), { code: "OBSERVATION_CURSOR_INVALID" });
  const otherEpoch = createObservationFeed({ workspaceKey: KEY });
  t.after(() => otherEpoch.dispose());
  assert.equal((await waiter.wait({ cursor: otherEpoch.observe(idle).cursor, timeoutMs: 20 })).reason, "supervisor-restarted");
  await assert.rejects(waiter.wait({ cursor: feed.observe(idle, { includeUsage: true }).cursor, timeoutMs: 20 }), { code: "OBSERVATION_CURSOR_INVALID" });
});
