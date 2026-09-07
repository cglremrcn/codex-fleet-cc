import assert from "node:assert/strict";
import test from "node:test";
import { createInboxView } from "../plugins/fleet/scripts/lib/inbox-view.mjs";
import { InterventionInbox, INBOX_METHODS } from "../plugins/fleet/scripts/lib/intervention-inbox.mjs";
import { createConsoleController } from "../plugins/fleet/scripts/lib/console-controller.mjs";
import { createInputDecoder } from "../plugins/fleet/scripts/lib/tui-input.mjs";
import { displayWidth } from "../plugins/fleet/scripts/lib/tui-render.mjs";
import { runCli } from "../plugins/fleet/scripts/lib/cli.mjs";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const terminal = { columns: 100, rows: 24 };
function fixture() {
  const replies = [], calls = [], inbox = new InterventionInbox({ send: async (...args) => replies.push(args), isCurrent: () => true });
  const lane = { id: "one", threadId: "thread", turnId: "turn", interactive: true, status: "running" };
  const id = inbox.receive({ id: 0, method: INBOX_METHODS.input, params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [{ id: "q", header: "Algorithm", question: "Choose an algorithm", isOther: true, isSecret: false, options: [{ label: "A", description: "Linear" }, { label: "B", description: "Indexed" }] }] } }, lane);
  const runtime = {
    inboxList: async (route) => { calls.push(["list", route]); return inbox.list(); },
    inboxInspect: async (route, key) => { calls.push(["inspect", route]); return inbox.inspect(key); },
    inboxPreview: async (route, ...args) => { calls.push(["preview", route]); return inbox.preview(...args); },
    inboxApply: async (route, token) => { calls.push(["apply", route]); return inbox.apply(token); }
  };
  const view = createInboxView({ runtime });
  return { view, inbox, id, replies, runtime, calls, lane };
}
async function detail(f, route = null) {
  f.view.open(route); await flush();
  f.view.handle({ type: "activate" }); await flush(); f.view.render(terminal);
}
function end(view) { view.handle({ type: "end" }); view.render(terminal); }
function key(view, value) { view.handle({ type: "text", value }); }

test("complete request review plus explicit Y is required; navigation cannot answer", async () => {
  const f = fixture(); await detail(f);
  key(f.view, "d"); await flush(); assert.equal(f.view.view().mode, "detail");
  end(f.view); key(f.view, "d"); await flush();
  assert.equal(f.view.view().mode, "confirm");
  key(f.view, "Y"); await flush(); assert.equal(f.inbox.inspect(f.id).state, "pending");
  end(f.view); key(f.view, "Y"); await flush();
  assert.equal(f.inbox.inspect(f.id).state, "delegated"); assert.equal(f.replies.length, 0);
});
test("question composer validates choices and previews the complete answer without sending", async () => {
  const f = fixture(); await detail(f); end(f.view); key(f.view, "a");
  assert.equal(f.view.view().mode, "answer");
  key(f.view, "Custom deterministic answer"); f.view.handle({ type: "applyFilter" }); await flush();
  assert.equal(f.view.view().mode, "confirm"); assert.equal(f.replies.length, 0);
  end(f.view); key(f.view, "Y"); await flush();
  assert.equal(f.replies.length, 1); assert.equal(f.replies[0][1].result.answers.q.answers[0], "Custom deterministic answer");
});
test("a stale request preview cannot send after another controller changed it", async () => {
  const f = fixture(); await detail(f); end(f.view); key(f.view, "x"); await flush();
  f.inbox.propose(f.id, 1, { note: "An updated suggestion" });
  end(f.view); key(f.view, "Y"); await flush();
  assert.equal(f.replies.length, 0); assert.equal(f.view.view().stale, true);
});
test("project routing is captured and used unchanged for preview and response", async () => {
  const f = fixture(), route = { originWorkspaceKey: "project-key", id: "one" }; await detail(f, route);
  route.originWorkspaceKey = "other-project";
  end(f.view); key(f.view, "x"); await flush(); end(f.view); key(f.view, "Y"); await flush();
  assert.ok(f.calls.every((call) => call[1].originWorkspaceKey === "project-key"));
});
test("slow inbox reads remain single-flight, Escape closes and late replies do not reopen", async () => {
  let resolve, count = 0;
  const view = createInboxView({ runtime: { inboxList: () => { count++; return new Promise((r) => { resolve = r; }); } } });
  view.open(); await flush(); for (let i = 0; i < 20; i++) view.handle({ type: "tick" });
  assert.equal(count, 1); view.handle({ type: "quit" }); assert.equal(view.view(), null);
  resolve({ requests: [] }); await flush(); assert.equal(view.view(), null);
});
test("slow responses are never duplicated; closing the UI does not claim a sent action was cancelled", async () => {
  const f = fixture(); let resolve, sends = 0;
  f.runtime.inboxApply = async () => { sends++; return new Promise((r) => { resolve = r; }); };
  await detail(f); end(f.view); key(f.view, "x"); await flush(); end(f.view);
  key(f.view, "Y"); await flush(); key(f.view, "Y"); assert.equal(sends, 1);
  f.view.handle({ type: "quit" }); resolve({ id: f.id, state: "sent" }); await flush();
  assert.equal(f.view.view().mode, "detail"); assert.equal(sends, 1);
});
test("all terminal dimensions stay bounded and tiny terminals cannot authorize", async () => {
  const f = fixture(); await detail(f);
  for (const columns of [1, 16, 39, 40, 80, 120]) for (const rows of [1, 4, 9, 10, 24]) {
    f.view.handle({ type: "end" }); const frame = f.view.render({ columns, rows });
    assert.equal(frame.split("\n").length, rows); assert.ok(frame.split("\n").every((line) => displayWidth(line) <= columns));
    if (columns < 40 || rows < 10) assert.notEqual(f.view.view().reviewed, 1);
  }
});
test("I opens the inbox, typed action letters are not global shortcuts, and KITE exposes it", async () => {
  const f = fixture(), controller = createConsoleController({ snapshot: { lanes: [f.lane] }, runtime: f.runtime, terminal, write: () => {} });
  const decoder = createInputDecoder(); assert.deepEqual(decoder.push("I"), [{ type: "inbox" }]);
  const response = await controller.dispatch({ type: "inbox" }); assert.equal(response.textMode, "palette"); await flush();
  decoder.setTextMode(response.textMode); assert.deepEqual(decoder.push("xK"), [{ type: "text", value: "x" }, { type: "text", value: "K" }]);
  await controller.dispatch({ type: "quit" }); await controller.dispatch({ type: "kite" });
  assert.equal(controller.state().overlay.kind, "kite"); assert.equal(f.replies.length, 0);
  controller.dispose();
});
test("Claude CLI exposes read/advice/delegated answers, not an approval switch or actor impersonation", async () => {
  const output = [], errors = [], io = { cwd: process.cwd(), stdout: (s) => output.push(s), stderr: (s) => errors.push(s), readStdin: async () => Buffer.from('{}') };
  const code = await runCli(["inbox", "--json"], io, { readSupervisorManifest: async () => null });
  assert.equal(code, 0); assert.deepEqual(JSON.parse(output.join("")).requests, []);
  const refused = await runCli(["inbox", "--approve", "--json"], io, {});
  assert.equal(refused, 2);
});

test("available actions are keyboard-selectable without knowing hidden letter shortcuts", async () => {
  const f = fixture(); await detail(f); end(f.view);
  f.view.handle({ type: "cyclePanel", delta: 1 });
  assert.match(f.view.render(terminal), /Answer questions/);
  f.view.handle({ type: "activate" });
  assert.equal(f.view.view().mode, "answer"); assert.equal(f.replies.length, 0);
});


test("command-center search and activation use the same inbox command registry", async () => {
  const f = fixture(), controller = createConsoleController({ snapshot: { lanes: [f.lane] }, runtime: f.runtime, terminal, write: () => {} });
  await controller.dispatch({ type: "palette" });
  for (const value of "intervention") await controller.dispatch({ type: "text", value });
  await controller.dispatch({ type: "activate" }); await flush();
  assert.equal(controller.state().inbox.mode, "list");
  assert.equal(controller.state().overlay, null); assert.equal(f.replies.length, 0);
  controller.dispose();
});

test("choice-only questions do not silently turn typing into an invalid free-text answer", async () => {
  const f = fixture(); f.inbox.entries.get(f.id).params.questions[0].isOther = false;
  await detail(f); end(f.view); key(f.view, "a"); key(f.view, "unlisted value");
  assert.equal(f.view.view().answerText, ""); assert.match(f.view.view().notice, /does not allow free text/);
  f.view.handle({ type: "move", delta: 1 }); f.view.handle({ type: "activate" }); await flush();
  assert.equal(f.view.view().confirmation.action.result.answers.q.answers[0], "B");
  assert.equal(f.replies.length, 0);
});
