import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InterventionInbox, INBOX_METHODS } from "../plugins/fleet/scripts/lib/intervention-inbox.mjs";
import { createRuntime } from "../plugins/fleet/scripts/lib/runtime-adapter.mjs";
import { createControlPlane } from "../plugins/fleet/scripts/fleet-supervisor.mjs";
import { createSupervisorServer, supervisorPaths, requestSupervisor } from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { workspaceKey } from "../plugins/fleet/scripts/lib/paths.mjs";
import { requestExistingInbox } from "../plugins/fleet/scripts/lib/inbox-client.mjs";
import { runCli } from "../plugins/fleet/scripts/lib/cli.mjs";

const lane = () => ({ id: "lane-a", threadId: "thread-a", turnId: "turn-a", status: "running", interactive: true });
const question = (id = 0, overrides = {}) => ({ id, method: INBOX_METHODS.input, params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", questions: [{ id: "q", header: "Design", question: "Which design?", isSecret: false, isOther: true, options: [{ label: "A", description: "First design" }, { label: "B", description: "Second design" }] }], ...overrides } });
const answer = (value = "A") => ({ answers: { q: { answers: [value] } } });
function fixture(options = {}) {
  let time = 1000, current = true;
  const replies = [], inbox = new InterventionInbox({ send: async (...args) => replies.push(args), isCurrent: () => current, now: () => time, ...options });
  const id = inbox.receive(question(), lane());
  return { inbox, id, replies, advance: (ms) => { time += ms; }, loseTurn: () => { current = false; } };
}
function preview(f, action) { return f.inbox.preview(f.id, f.inbox.inspect(f.id).revision, action); }
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("numeric request zero and string zero are distinct; identical replay does not duplicate", () => {
  const f = fixture();
  assert.equal(f.inbox.receive(question(), lane()), f.id);
  f.inbox.receive(question("0"), lane());
  assert.equal(f.inbox.list().requests.length, 2);
  assert.throws(() => f.inbox.receive(question(0, { itemId: "changed" }), lane()), { code: "FLEET_INBOX_COLLISION" });
});
test("proposal is advice only and invalidates an older confirmation", async () => {
  const f = fixture(), old = preview(f, { type: "answer", result: answer() });
  const revised = f.inbox.propose(f.id, 1, { note: "Prefer deterministic behavior.", result: answer("B") });
  assert.equal(revised.revision, 2); assert.equal(f.replies.length, 0);
  await assert.rejects(f.inbox.apply(old.confirmationToken), { code: "FLEET_INBOX_STALE" });
  await f.inbox.apply(preview(f, { type: "answer", result: revised.proposal.result }).confirmationToken);
  assert.equal(f.replies.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(f.replies[0])), [0, { result: answer("B") }]);
});
test("a per-question delegation is required and human takeover revokes it", async () => {
  const f = fixture();
  await assert.rejects(f.inbox.answerDelegated(f.id, 1, "a".repeat(64), answer()), { code: "FLEET_INBOX_DENIED" });
  const grant = await f.inbox.apply(preview(f, { type: "delegate" }).confirmationToken);
  assert.equal(grant.state, "delegated"); assert.ok(grant.delegation.token);
  assert.equal(f.inbox.list().requests[0].delegation, undefined);
  await f.inbox.apply(preview(f, { type: "takeover" }).confirmationToken);
  await assert.rejects(f.inbox.answerDelegated(f.id, grant.revision, grant.delegation.token, answer()));
  assert.equal(f.replies.length, 0);
});
test("delegated technical answer is one-shot, exact-target and expires", async () => {
  const f = fixture(), grant = await f.inbox.apply(preview(f, { type: "delegate" }).confirmationToken);
  await f.inbox.answerDelegated(f.id, grant.revision, grant.delegation.token, answer());
  await assert.rejects(f.inbox.answerDelegated(f.id, grant.revision, grant.delegation.token, answer()));
  assert.equal(f.replies.length, 1);
  const g = fixture(), old = await g.inbox.apply(preview(g, { type: "delegate" }).confirmationToken);
  g.advance(90_001);
  await assert.rejects(g.inbox.answerDelegated(g.id, old.revision, old.delegation.token, answer()));
  assert.equal(g.inbox.inspect(g.id).state, "pending");
});
test("approval-shaped user input can be advised and manually answered but never delegated", () => {
  const f = fixture(), q = question(2); q.params.questions[0].options[0].label = "Accept";
  const id = f.inbox.receive(q, lane()), detail = f.inbox.inspect(id);
  assert.equal(detail.kind, "approval"); assert.ok(detail.actions.includes("answer"));
  assert.ok(!detail.actions.includes("delegate"));
  assert.throws(() => f.inbox.preview(id, detail.revision, { type: "delegate" }));
});
for (const mutate of [
  (q) => { q.params.questions[0].isSecret = true; },
  (q) => { delete q.params.questions[0].isSecret; },
  (q) => { q.params.questions[0].id = "__proto__"; },
  (q) => { q.params.questions.push(q.params.questions[0]); },
  (q) => { q.params.turnId = "old"; },
  (q) => { q.id = {}; },
  (q) => { q.params.questions[0].question = "x".repeat(9000); },
  (q) => { q.method = "account/chatgptAuthTokens/refresh"; }
]) test(`malformed, secret or unowned request is rejected (${mutate.toString().slice(0, 65)})`, () => {
  const f = fixture(), q = question(3); mutate(q); assert.throws(() => f.inbox.receive(q, lane())); assert.equal(f.inbox.list().requests.length, 1);
});
test("sensitive/redacted details cannot authorize acceptance or delegation", () => {
  const f = fixture(), q = question(4); q.params.questions[0].question = "Use password=private-fixture-value?";
  const d = f.inbox.inspect(f.inbox.receive(q, lane()));
  assert.equal(d.completeDetails, false); assert.deepEqual(d.actions, ["reject"]);
  assert.ok(!JSON.stringify(d).includes("private-fixture-value"));
});
for (const result of [{}, { answers: {} }, { answers: { other: { answers: ["A"] } } }, { answers: { q: { answers: ["A", "B"] } } }, { answers: { q: { answers: ["password=fixture-secret"] } } }]) {
  test(`answer shape is strict (${JSON.stringify(result)})`, () => { const f = fixture(); assert.throws(() => preview(f, { type: "answer", result })); assert.equal(f.replies.length, 0); });
}
test("command approval requires opt-in and only accepts once, never session grants", async () => {
  const f = fixture(), request = { ...question(5), method: INBOX_METHODS.command }; delete request.params.questions; request.params.command = "node --test";
  assert.throws(() => f.inbox.receive(request, { ...lane(), interactive: false }));
  const id = f.inbox.receive(request, lane());
  assert.throws(() => f.inbox.preview(id, 1, { type: "acceptForSession" }));
  assert.throws(() => f.inbox.preview(id, 1, { type: "accept", result: { decision: "acceptForSession" } }));
  await f.inbox.apply(f.inbox.preview(id, 1, { type: "accept" }).confirmationToken);
  assert.deepEqual(f.replies.at(-1), [5, { result: { decision: "accept" } }]);
});
test("file approval without its actual proposed diff is deny-only", () => {
  const f = fixture(), request = { ...question(6), method: INBOX_METHODS.file }; delete request.params.questions;
  const d = f.inbox.inspect(f.inbox.receive(request, lane())); assert.deepEqual(d.actions, ["reject"]);
  request.id = 7;
  const d2 = f.inbox.inspect(f.inbox.receive(request, { ...lane(), interventionItems: new Map([["item-a", [{ path: "src/parser.mjs", diff: "+export const x = 1" }]]]) }));
  assert.ok(d2.actions.includes("accept")); assert.match(d2.details, /export const x/);
});
test("permission approval grants only the exact requested subset for this turn", async () => {
  const f = fixture(), request = { ...question(8), method: INBOX_METHODS.permissions }; delete request.params.questions;
  request.params.permissions = { network: { enabled: true }, fileSystem: null };
  const id = f.inbox.receive(request, lane());
  await f.inbox.apply(f.inbox.preview(id, 1, { type: "accept" }).confirmationToken);
  assert.deepEqual(f.replies.at(-1), [8, { result: { permissions: { network: { enabled: true } }, scope: "turn" } }]);
});
test("concurrent confirmations produce only one wire response", async () => {
  let release; const responses = [];
  const f = fixture({ send: (...args) => { responses.push(args); return new Promise((resolve) => { release = resolve; }); } });
  const first = preview(f, { type: "answer", result: answer() }), second = preview(f, { type: "answer", result: answer("B") });
  const sending = f.inbox.apply(first.confirmationToken);
  await assert.rejects(f.inbox.apply(second.confirmationToken), { code: "FLEET_INBOX_STALE" });
  release(); await sending; assert.equal(responses.length, 1);
});
test("unknown delivery is not retried; pre-write server clear is not overwritten", async () => {
  const f = fixture({ send: async () => { throw new Error("pipe lost"); } });
  const sent = await f.inbox.apply(preview(f, { type: "answer", result: answer() }).confirmationToken);
  assert.equal(sent.state, "unknown"); assert.throws(() => preview(f, { type: "answer", result: answer() }));
  let inbox;
  const g = fixture({ send: async () => inbox.resolved("thread-a", 0) }); inbox = g.inbox;
  const cleared = await inbox.apply(preview(g, { type: "answer", result: answer() }).confirmationToken);
  assert.equal(cleared.state, "resolved");
});
test("timeouts, completion, disconnect and stale confirmations do not auto-answer", async () => {
  const f = fixture(), old = preview(f, { type: "delegate" }); f.advance(60_001);
  await assert.rejects(f.inbox.apply(old.confirmationToken));
  f.advance(900_000); f.inbox.list(); await flush();
  assert.equal(f.inbox.inspect(f.id).state, "expired"); assert.equal(f.replies[0][1].error.code, -32000);
  const g = fixture(); g.loseTurn(); assert.equal(g.inbox.inspect(g.id).state, "expired"); assert.equal(g.replies.length, 0);
  const h = fixture(); h.inbox.disconnect(); assert.equal(h.inbox.inspect(h.id).state, "expired");
});
test("bounded inbox refuses flooding without evicting actionable requests", () => {
  const f = fixture(); for (let i = 1; i < 64; i++) f.inbox.receive(question(i), lane());
  assert.throws(() => f.inbox.receive(question(64), lane()), /capacity/); assert.equal(f.inbox.list().requests.length, 64);
});
test("empty inbox read never starts a supervisor and mutation cannot replay after restart", async () => {
  const deps = { readSupervisorManifest: async () => null, requestSupervisor: () => assert.fail("Unexpected transport") };
  assert.equal((await requestExistingInbox({}, "inbox", {}, deps)).connected, false);
  await assert.rejects(requestExistingInbox({}, "inboxApply", {}, deps), /No existing/);
});

test("real JSONL broker plus authenticated IPC preserves request, proposal, delegation and response identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-inbox-e2e-"));
  const dataDir = path.join(root, "data"), workspacePath = path.join(root, "workspace");
  await fs.mkdir(workspacePath); const key = await workspaceKey(workspacePath), token = "a".repeat(64);
  let runtime, runtimeCount = 0;
  const control = createControlPlane({ dataDir, workspacePath, workspaceKey: key, token,
    createRuntime: async () => { runtimeCount++; runtime = await createRuntime({ cwd: workspacePath, codexCommand: { executable: process.execPath, args: [path.resolve("tests/fixtures/inbox-app-server.mjs")] } }); return runtime; }
  });
  const server = await createSupervisorServer({ ...supervisorPaths({ dataDir, workspaceKey: key }), workspaceKey: key, token, handleRequest: ({ method, params }) => control.handle(method, params) });
  t.after(async () => { await control.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (method, params = {}) => requestSupervisor({ address: server.address, workspaceKey: key, token, method, params });
  assert.deepEqual((await call("inbox")).requests, []); assert.equal(runtimeCount, 0);
  await call("start", { schemaVersion: 1, workspacePath, lanes: [{ id: "inbox-e2e", role: "investigator", label: "Inbox transport", model: "gpt-5.6-sol", effort: "high", prompt: "Exercise bounded input", interactive: true, authority: { process: { start: true, stopOwned: true } } }] });
  const item = (await call("inbox")).requests[0]; assert.ok(item); assert.equal(item.turnId, "turn-1");
  const result = { answers: { approach: { answers: ["Deterministic parser"] } } };
  const proposal = await call("inboxPropose", { id: item.id, revision: item.revision, proposal: { note: "Avoid a model for deterministic parsing.", result } });
  assert.equal((await runtime.broker.request("test/observation", {})).lastReply, null);
  const review = await call("inboxPreview", { id: item.id, revision: proposal.revision, action: { type: "delegate" } });
  const grant = await call("inboxApply", { confirmationToken: review.confirmationToken });
  await call("inboxAnswer", { id: item.id, revision: grant.revision, delegationToken: grant.delegation.token, result });
  await assert.rejects(call("inboxAnswer", { id: item.id, revision: grant.revision, delegationToken: grant.delegation.token, result }));
  let observed;
  for (let attempt = 0; attempt < 100; attempt++) { observed = await runtime.broker.request("test/observation", {}); if (observed.lastReply) break; await new Promise((r) => setTimeout(r, 10)); }
  assert.deepEqual(observed.lastReply, { id: 0, result }); assert.equal(observed.starts, 1);
  assert.deepEqual(observed.policies, ["on-request", "on-request"]);
  assert.equal((await call("inboxInspect", { id: item.id })).state, "resolved");
  for (let attempt = 0; attempt < 100; attempt++) { const status = await call("status"); if (status.lanes[0].status === "complete") break; await new Promise((r) => setTimeout(r, 10)); }
  assert.equal((await call("status")).lanes[0].pendingRequests, 0);
  const stateText = await fs.readFile(path.join(dataDir, "workspaces", key, "state.json"), "utf8");
  assert.ok(!stateText.includes(grant.delegation.token)); assert.ok(!stateText.includes("Deterministic parser"));
});

test("server-offered decisions restrict acceptance; network-specific requests show the actual destination", () => {
  const f = fixture(), request = { ...question(9), method: INBOX_METHODS.command };
  delete request.params.questions; request.params.networkApprovalContext = { host: "example.test", protocol: "https", port: 443 };
  request.params.availableDecisions = ["decline", "cancel"];
  const d = f.inbox.inspect(f.inbox.receive(request, lane()));
  assert.ok(!d.actions.includes("accept")); assert.match(d.details, /example\.test/);
});
test("retired wire identities remain tombstoned after bounded history eviction", () => {
  const f = fixture(); f.inbox.resolved("thread-a", 0);
  for (let id = 1; id < 140; id++) { f.inbox.receive(question(id), lane()); f.inbox.resolved("thread-a", id); }
  assert.ok(f.inbox.entries.size <= 128); assert.ok(!f.inbox.entries.has(f.id));
  assert.equal(f.inbox.receive(question(0), lane()), f.id);
  assert.ok(!f.inbox.entries.has(f.id)); assert.equal(f.replies.length, 0);
});
test("terminal entries clear request bodies and proposals, retaining only identity and response digest", async () => {
  const f = fixture();
  f.inbox.propose(f.id, 1, { note: "Private contextual advice", result: answer() });
  await f.inbox.apply(preview(f, { type: "answer", result: answer() }).confirmationToken);
  f.inbox.resolved("thread-a", 0); const d = f.inbox.inspect(f.id);
  assert.equal(d.questions, null); assert.equal(d.proposal, null); assert.match(d.responseDigest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(f.inbox.entries.get(f.id)).includes("Private contextual advice"));
});

test("revision changes release obsolete previews and their private answer drafts", () => {
  const f = fixture();
  for (let index = 0; index < 64; index += 1) {
    preview(f, { type: "answer", result: answer("Private draft context") });
  }
  f.inbox.propose(f.id, 1, { note: "Updated advice" });
  assert.equal(f.inbox.previews.size, 0);
  assert.doesNotThrow(() => preview(f, { type: "reject" }));
});

test("terminal cleanup removes titles and every outstanding answer preview", () => {
  const f = fixture();
  const request = question(42);
  request.params.questions[0].header = "Private project question";
  const id = f.inbox.receive(request, lane());
  const review = f.inbox.preview(id, 1, {
    type: "answer", result: answer("Private answer context")
  });
  f.inbox.resolved("thread-a", 42);
  assert.equal(f.inbox.previews.has(review.confirmationToken), false);
  assert.ok(!JSON.stringify(f.inbox.inspect(id)).includes("Private project question"));
});
