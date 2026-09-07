import assert from "node:assert/strict";
import test from "node:test";
import { deriveKiteSignal, renderKiteAvatar, kiteIsAnimated } from "../plugins/fleet/scripts/lib/kite-companion.mjs";
import { createConsoleController } from "../plugins/fleet/scripts/lib/console-controller.mjs";
import { createInputDecoder } from "../plugins/fleet/scripts/lib/tui-input.mjs";
import { buildViewModel, displayWidth, renderFleetMark, renderScreen, stripAnsi } from "../plugins/fleet/scripts/lib/tui-render.mjs";
const lane = (status = "running", extra = {}) => ({ id: "worker", label: "Worker", status, phase: status, authority: {}, ...extra });
const view = (status, extra = {}) => buildViewModel({ lanes: [lane(status, extra)], runtime: { health: "ready" } }, "worker");

test("KITE never presents an empty fleet as queued work or fabricated progress", () => {
  const signal = deriveKiteSignal(buildViewModel({ lanes: [] }));
  assert.equal(signal.state, "idle"); assert.equal(signal.animated, false);
  assert.doesNotMatch(signal.description, /\d+%/u);
});
test("stale observation overrides a smiling verified posture", () => {
  const stale = buildViewModel({ lanes: [lane("verified")] }, "worker", "detail", { observation: "stale" });
  const signal = deriveKiteSignal(stale); assert.equal(signal.state, "stale");
  assert.equal(signal.animated, false); assert.doesNotMatch(renderKiteAvatar(signal).join("\n"), /✓/u);
});
test("typed approvals and questions have separate signals and a generic pending request stays unclassified", () => {
  assert.equal(deriveKiteSignal(view("running", { pendingRequests: 1, pendingApprovalCount: 1 })).state, "approval");
  assert.equal(deriveKiteSignal(view("running", { pendingRequests: 1, pendingQuestionCount: 1 })).state, "question");
  assert.equal(deriveKiteSignal(view("running", { pendingRequests: 1 })).state, "attention");
});
test("completion remains distinct from independently verified work", () => {
  const complete = deriveKiteSignal(view("complete")); const verified = deriveKiteSignal(view("verified"));
  assert.match(complete.description, /not.*verified/iu); assert.notDeepEqual(complete, verified);
});
for (const state of ["idle", "observed", "queued", "starting", "running", "complete", "verified", "blocked", "failed", "cancelled", "interrupted", "outcome_unknown", "approval", "question", "stale", "attention"]) {
  test(`KITE ${state} is bounded, deterministic, ASCII-safe and reduced-motion-safe`, () => {
    const signal = { state, animated: ["running", "starting", "queued", "complete"].includes(state) };
    for (const unicode of [true, false]) {
      const a = renderKiteAvatar(signal, { frame: 0, unicode, reducedMotion: true });
      const b = renderKiteAvatar(signal, { frame: 7, unicode, reducedMotion: true });
      assert.deepEqual(a, b); assert.equal(a.length, 7);
      assert.ok(a.every((line) => displayWidth(line) <= 27));
      if (!unicode) assert.ok(a.every((line) => /^[\x20-\x7e]*$/u.test(line)));
    }
    assert.equal(kiteIsAnimated(signal, { mascot: false }), false);
  });
}
test("uppercase K opens companion without stealing lowercase k navigation or typed K", () => {
  const decoder = createInputDecoder();
  assert.deepEqual(decoder.push("Kk"), [{ type: "kite" }, { type: "move", delta: -1 }]);
  decoder.setTextMode("composer"); assert.deepEqual(decoder.push("K"), [{ type: "text", value: "K" }]);
});
test("companion is an interactive local overlay and never runs model actions", async () => {
  let calls = 0; const writes = [];
  const controller = createConsoleController({ snapshot: { lanes: [lane()] }, terminal: { columns: 100, rows: 28 },
    write: (s) => writes.push(s), runtime: { message: () => { calls++; } }, preferences: { color: false } });
  await controller.dispatch({ type: "kite" }); assert.equal(controller.state().overlay?.kind, "kite");
  assert.match(writes.at(-1), /KITE.*COMPANION/u); assert.match(writes.at(-1), /RUNNING/u);
  await controller.dispatch({ type: "activate" }); assert.equal(controller.state().sort, "attention"); assert.equal(calls, 0);
});
test("hidden, stale and inactive mascot ticks do not redraw identical screens", async () => {
  for (const options of [{ status: "verified" }, { status: "running", mascot: false }, { status: "running", observation: "stale" }]) {
    const writes = [];
    const controller = createConsoleController({ snapshot: { lanes: [lane(options.status)] }, initialObservation: options.observation,
      savedViewState: { current: { mascot: options.mascot } }, write: (s) => writes.push(s), preferences: { color: false } });
    await controller.render(); for (let i = 0; i < 5; i++) await controller.dispatch({ type: "tick" });
    assert.equal(writes.length, 1);
  }
});
test("mascot and companion respect tiny, narrow, wide and screen-reader layouts", async () => {
  for (const columns of [1, 16, 32, 55, 80, 120, 160]) {
    for (const rows of [4, 8, 16, 28]) {
      const writes = [];
      const controller = createConsoleController({ snapshot: { lanes: [lane()] }, terminal: { columns, rows }, write: (s) => writes.push(s), preferences: { color: false } });
      await controller.dispatch({ type: "kite" }); const lines = stripAnsi(writes.at(-1)).split("\n");
      assert.ok(lines.length <= rows); assert.ok(lines.every((l) => displayWidth(l) <= columns));
    }
  }
  const screen = renderScreen(view("running"), { columns: 100, rows: 28 }, { screenReader: true });
  assert.doesNotMatch(screen, /╭|●|KITE/u);
  assert.deepEqual(renderFleetMark(view("running"), { mascot: false }), []);
});
test("a slow thread read never blocks Escape or lets an old response reopen a session", async () => {
  let resolve;
  const controller = createConsoleController({ snapshot: { lanes: [lane("running", { threadId: "thread-1" })] },
    runtime: { session: () => new Promise((r) => { resolve = r; }) }, refreshTimeoutMs: 20, write: () => {} });
  const opened = await Promise.race([controller.dispatch({ type: "activate" }).then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);
  assert.equal(opened, true, "opening metadata must not await the network");
  await controller.dispatch({ type: "closeSession" }); resolve({ messages: [{ kind: "assistant", text: "late" }] });
  await new Promise((r) => setImmediate(r)); assert.equal(controller.state().session, null);
  controller.dispose();
});
test("timed-out session reads stay single-flight and cannot replace a reopened session", async () => {
  let calls = 0; const resolvers = [];
  const controller = createConsoleController({ snapshot: { lanes: [lane("running", { threadId: "thread-1" })] },
    runtime: { session: () => { calls++; return new Promise((r) => resolvers.push(r)); } }, refreshTimeoutMs: 5, write: () => {} });
  await controller.dispatch({ type: "activate" }); await new Promise((r) => setTimeout(r, 12));
  for (let i = 0; i < 12; i++) await controller.dispatch({ type: "tick" });
  assert.equal(calls, 1); assert.match(controller.state().session.error, /stale|timed out/iu);
  await controller.dispatch({ type: "closeSession" }); await controller.dispatch({ type: "activate" });
  resolvers[1]({ threadId: "thread-1", messages: [{ kind: "assistant", text: "current" }] });
  await new Promise((r) => setImmediate(r)); resolvers[0]({ messages: [{ kind: "assistant", text: "old" }] });
  await new Promise((r) => setImmediate(r)); assert.equal(controller.state().session.messages[0].text, "current");
  controller.dispose();
});
