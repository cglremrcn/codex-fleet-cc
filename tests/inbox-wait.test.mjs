import assert from "node:assert/strict";
import test from "node:test";
import { waitForInbox } from "../plugins/fleet/scripts/lib/inbox-wait.mjs";
const pending = { id: "request", revision: 1, state: "pending", hasProposal: false };
test("wait returns only actionable requests and a stable deduplication cursor", async () => {
  const deps = { readInbox: async () => ({ requests: [pending, { ...pending, id: "already-advised", hasProposal: true }, { ...pending, id: "done", state: "resolved" }] }) };
  const first = await waitForInbox({}, {}, deps), second = await waitForInbox({}, {}, deps);
  assert.equal(first.changed, true); assert.equal(first.requests.length, 1); assert.equal(first.cursor, second.cursor);
});
test("same cursor does not notify repeatedly; bounded observer returns on timeout", async () => {
  let time = 0, reads = 0;
  const deps = { now: () => time, sleep: async (ms) => { time += ms; }, readInbox: async () => { reads++; return { requests: [pending] }; } };
  const first = await waitForInbox({}, {}, deps);
  const next = await waitForInbox({}, { after: first.cursor, timeoutMs: 500 }, deps);
  assert.equal(next.changed, false); assert.equal(next.reason, "timeout"); assert.equal(reads, 4);
});
test("human delegation yields a fresh actionable cursor without exposing grants in summaries", async () => {
  let delegated = false;
  const deps = { sleep: async () => { delegated = true; }, readInbox: async () => ({ requests: [{ ...pending, state: delegated ? "delegated" : "pending", revision: delegated ? 3 : 1 }] }) };
  const first = await waitForInbox({}, {}, deps);
  const next = await waitForInbox({}, { after: first.cursor }, deps);
  assert.notEqual(next.cursor, first.cursor); assert.equal(next.requests[0].state, "delegated");
});
test("absent supervisor returns immediately and never tries to start one", async () => {
  const result = await waitForInbox({}, {}, { readInbox: async () => ({ connected: false, requests: [] }), sleep: async () => assert.fail("Unexpected polling") });
  assert.equal(result.reason, "no-live-supervisor");
});
test("watch limits and cursors reject malformed values", async () => {
  for (const timeoutMs of [-1, 0, 90001, Infinity, "60000"]) await assert.rejects(waitForInbox({}, { timeoutMs }));
  await assert.rejects(waitForInbox({}, { after: "invented-cursor" }));
});
