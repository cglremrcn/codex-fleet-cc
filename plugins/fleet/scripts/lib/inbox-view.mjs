import { displayWidth, stripAnsi } from "./tui-render.mjs";

const LIVE = new Set(["pending", "delegated", "sending", "sent"]);
const COMMAND = Object.freeze({ id: "inbox", title: "Shared intervention inbox", description: "Review questions, Claude proposals and operation approvals separately" });
export const INBOX_COMMAND = COMMAND;
const clean = (value) => stripAnsi(String(value ?? "")).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
function wrap(value, width) {
  const result = [];
  for (const raw of String(value ?? "").split("\n")) {
    let line = "";
    for (const char of clean(raw)) {
      if (displayWidth(line + char) > width && line) { result.push(line); line = ""; }
      if (displayWidth(char) <= width) line += char;
    }
    result.push(line);
  }
  return result;
}
const clip = (text, width) => wrap(text, width)[0] ?? "";

/** Local interaction only. UI delays do not grant authority; the supervisor revalidates every action. */
export function createInboxView(options) {
  const runtime = options.runtime;
  let state = null, generation = 0, pending = null, disposed = false;
  const notify = () => { if (!disposed) options.onChange?.(); };
  const view = () => state;
  function close() { generation += 1; state = null; pending = null; notify(); }
  function launch(work, apply, { mutation = false } = {}) {
    if (!state || pending) return;
    const at = generation, operation = {}; pending = operation; state.busy = true;
    if (mutation) state.notice = "Sending once. A lost response will not be retried automatically.";
    const timer = setTimeout(() => {
      if (state && at === generation && pending === operation) { state.notice = mutation ? "Response delayed: outcome may be unknown. Do not repeat the action." : "Inbox observation delayed. Escape remains available."; notify(); }
    }, 1000); timer.unref?.();
    Promise.resolve().then(work).then((result) => {
      if (state && at === generation) apply(result);
    }).catch(() => {
      if (state && at === generation) { state.notice = mutation ? "Action not confirmed. Refresh; never repeat an uncertain answer." : "Inbox read failed or request changed. Refresh before acting."; state.stale = true; }
    }).finally(() => {
      clearTimeout(timer);
      if (pending === operation) pending = null;
      if (state && at === generation) { state.busy = false; notify(); }
    });
  }
  function rows() {
    return (state?.requests ?? []).filter((r) => (state.category === "history" ? !LIVE.has(r.state) : LIVE.has(r.state))
      && (!["question", "approval"].includes(state.category) || r.kind === state.category));
  }
  function refresh() {
    if (!state || pending || state.mode !== "list") return;
    launch(() => runtime.inboxList(state.route), (result) => {
      if (!result || !Array.isArray(result.requests) || result.requests.length > 128) throw new Error("Malformed inbox list.");
      state.requests = result.requests; state.stale = false;
      const visible = rows();
      if (!visible.some((r) => r.id === state.selected)) state.selected = visible[0]?.id ?? null;
      state.notice = result.connected === false ? "No live supervisor. Viewing does not start one." : "Metadata only; opening this inbox does not call a model.";
    });
  }
  function open(route = null) {
    generation += 1; pending = null;
    state = { mode: "list", route: route ? structuredClone(route) : null, requests: [], selected: null,
      category: "all", detail: null, scroll: 0, reviewed: null, confirmation: null,
      notice: "Reading existing supervisor...", busy: false, stale: false, ticks: 0 };
    refresh(); notify();
  }
  function inspect(id) {
    const route = state.route;
    launch(() => runtime.inboxInspect(route, id), (detail) => {
      if (detail?.id !== id || !Array.isArray(detail.actions)) throw new Error("Wrong inbox target.");
      state.detail = detail; state.mode = "detail"; state.scroll = 0; state.reviewed = null;
      state.stale = false; state.confirmation = null; state.actionIndex = 0; state.notice = "Read the complete request before answering or delegating.";
    });
  }
  function preview(action) {
    const d = state.detail;
    if (!d || state.adequate === false || state.stale || state.reviewed !== d.revision || !d.actions.includes(action.type)) {
      state.notice = "Read through the full request (End), then choose an available action."; return;
    }
    const route = state.route;
    launch(() => runtime.inboxPreview(route, d.id, d.revision, action), (confirmation) => {
      if (confirmation?.request?.id !== d.id || confirmation.request.revision !== d.revision) throw new Error("Review identity changed.");
      state.confirmation = confirmation; state.mode = "confirm"; state.scroll = 0; state.confirmRead = false;
      state.notice = "Nothing sent to Codex yet. Review the exact action; Y confirms once, Esc returns.";
    });
  }
  function detailActions() {
    const d = state?.detail;
    const labels = { answer: ["a", "Answer questions"], delegate: ["d", "Delegate this technical question"], takeover: ["t", "Take back control"], accept: ["y", "Review operation grant"], reject: ["x", "Reject request"] };
    const actions = (d?.actions ?? []).map((type) => ({ type, key: labels[type]?.[0], title: labels[type]?.[1] })).filter((a) => a.key);
    if (d?.proposal?.result && d.actions.includes("answer")) actions.unshift({ key: "p", title: "Review controller's proposed answer" });
    return actions;
  }
  function questionNext() {
    const q = state.detail.questions[state.questionIndex];
    const answer = state.answerText.trim() || q.options?.[state.optionIndex]?.label;
    if (!answer) { state.notice = "Enter an answer; no default response is invented."; return; }
    state.answers[q.id] = { answers: [answer] };
    state.questionIndex += 1; state.answerText = ""; state.optionIndex = 0;
    if (state.questionIndex >= state.detail.questions.length) {
      state.mode = "detail"; preview({ type: "answer", result: { answers: state.answers } });
    }
  }
  function handle(event) {
    if (!state) return;
    if (["quit", "closeSession", "clearFilter", "discardMessage"].includes(event.type)) {
      if (state.mode === "list") close();
      else {
        // Dismissal cancels local UI work, never implies cancellation of a transmitted action.
        generation += 1; pending = null; state.busy = false;
        state.mode = state.mode === "detail" ? "list" : "detail";
        state.confirmation = null; state.notice = "Returned locally. No automatic resend.";
      }
      notify(); return;
    }
    if (event.type === "tick") { state.ticks += 1; if (state.ticks % 4 === 0) refresh(); return; }
    if (event.type === "resize") return;
    if (state.busy) return;
    const character = event.type === "text" ? event.value : "";
    const enter = ["activate", "applyFilter", "submitMessage"].includes(event.type);
    if (state.mode === "list") {
      const list = rows(), index = Math.max(0, list.findIndex((r) => r.id === state.selected));
      if (event.type === "move") state.selected = list[Math.max(0, Math.min(list.length - 1, index + event.delta))]?.id;
      else if (event.type === "home") state.selected = list[0]?.id;
      else if (event.type === "end") state.selected = list.at(-1)?.id;
      else if (event.type === "page") state.selected = list[Math.max(0, Math.min(list.length - 1, index + event.delta * 8))]?.id;
      else if (event.type === "mouseDown" && event.button === 0 && event.row >= 3) {
        const offset = Math.max(0, index - (state.listCapacity ?? 1) + 1);
        state.selected = list[offset + event.row - 3]?.id ?? state.selected;
      }
      else if (enter && state.selected) inspect(state.selected);
      else if (["1", "2", "3", "4"].includes(character)) { state.category = ["all", "question", "approval", "history"][Number(character) - 1]; state.selected = rows()[0]?.id ?? null; }
      else if (character === "r") refresh();
    } else if (state.mode === "answer") {
      if (event.type === "text") {
        const q = state.detail.questions[state.questionIndex];
        if (q.options?.length && !q.isOther) state.notice = "Choose an available option with arrows; this question does not allow free text.";
        else state.answerText = `${state.answerText}${event.value}`.slice(0, 4096);
      }
      else if (event.type === "backspace") state.answerText = Array.from(state.answerText).slice(0, -1).join("");
      else if (event.type === "move") state.optionIndex = Math.max(0, Math.min((state.detail.questions[state.questionIndex].options?.length ?? 1) - 1, state.optionIndex + event.delta));
      else if (enter) questionNext();
    } else if (state.mode === "confirm") {
      if (character === "Y" && state.confirmRead) {
        const token = state.confirmation.confirmationToken, route = state.route;
        launch(() => runtime.inboxApply(route, token), (result) => {
          state.detail = null; state.mode = "list"; state.confirmation = null;
          state.notice = `Request ${result.state}; sent is not proof that an operation succeeded.`;
          state.requests = state.requests.map((r) => r.id === result.id ? result : r);
        }, { mutation: true });
      } else scroll(event);
    } else {
      if (event.type === "cyclePanel") state.actionIndex = Math.max(0, Math.min(detailActions().length - 1, (state.actionIndex ?? 0) + event.delta));
      else if (enter) { const chosen = detailActions()[state.actionIndex ?? 0]; if (chosen) handle({ type: "text", value: chosen.key }); }
      else if (character === "u") inspect(state.detail.id);
      else if (character === "d") preview({ type: "delegate" });
      else if (character === "t") preview({ type: "takeover" });
      else if (character === "x") preview({ type: "reject" });
      else if (character === "y") preview({ type: "accept" });
      else if (character === "p" && state.detail.proposal?.result) preview({ type: "answer", result: state.detail.proposal.result });
      else if (character === "a" && state.reviewed === state.detail.revision && state.detail.actions.includes("answer")) {
        state.mode = "answer"; state.answers = Object.create(null); state.answerText = ""; state.questionIndex = 0; state.optionIndex = 0;
      } else scroll(event);
    }
    notify();
  }
  function scroll(event) {
    if (event.type === "move") state.scroll = Math.max(0, state.scroll + event.delta);
    else if (event.type === "page") state.scroll = Math.max(0, state.scroll + event.delta * 10);
    else if (event.type === "home") state.scroll = 0;
    else if (event.type === "end") state.scroll = Number.MAX_SAFE_INTEGER;
  }
  function render(terminal) {
    if (!state) return "";
    const width = Math.max(1, terminal.columns ?? 80), height = Math.max(1, terminal.rows ?? 24);
    state.adequate = width >= 40 && height >= 10;
    if (!state.adequate) { state.reviewed = null; state.confirmRead = false; }
    const d = state.detail, heading = `INTERVENTION INBOX / ${state.mode.toUpperCase()}`;
    const lines = [heading, state.mode === "list" ? `1 All | 2 Questions | 3 Approvals | 4 History / ${state.category}` : `${d?.kind?.toUpperCase() ?? ""} | ${d?.laneId ?? ""} | revision ${d?.revision ?? "?"}`];
    const capacity = Math.max(1, height - 5);
    state.listCapacity = capacity;
    if (state.mode === "list") {
      const list = rows(), index = Math.max(0, list.findIndex((r) => r.id === state.selected));
      const offset = Math.max(0, index - capacity + 1);
      for (const r of list.slice(offset, offset + capacity)) lines.push(`${r.id === state.selected ? ">" : " "} ${r.kind === "approval" ? "!" : "?"} ${r.state} | ${r.laneId} | ${r.title}${r.hasProposal ? " [Controller proposal]" : ""}`);
      if (!list.length) lines.push("No requests in this category. Stale/closed supervisors are not silently restarted.");
    } else if (state.mode === "answer") {
      const question = d.questions[state.questionIndex];
      const body = wrap(`QUESTION ${state.questionIndex + 1}/${d.questions.length}: ${question.question}`, width);
      // The full question was reviewed before entering; the options remain navigable on small terminals.
      lines.push(...body.slice(0, Math.max(1, capacity - 4)));
      const optionsCapacity = Math.max(1, height - lines.length - 4);
      const offset = Math.max(0, state.optionIndex - optionsCapacity + 1);
      for (const [index, option] of (question.options ?? []).slice(offset, offset + optionsCapacity).entries()) lines.push(`${offset + index === state.optionIndex ? ">" : " "} ${option.label}`);
      lines.push(`Answer: ${state.answerText || (question.options?.length && !question.isOther ? "[use selected option]" : "[use selected option or type]")}_`);
    } else {
      const content = state.mode === "confirm"
        ? `EXACT ACTION (no session-wide grant):\n${JSON.stringify(state.confirmation.action, null, 2)}\n\n${state.confirmation.action.type === "delegate" ? "You classify THIS reviewed request as a technical question, without operation authority. Claude may answer once within 90 seconds. Takeover revokes the grant." : "Acceptance may execute the requested operation. It is not evidence of success."}\n\nTarget: ${d.threadId} / ${d.turnId} / ${d.itemId}\nRequest: ${d.id} / revision ${d.revision}`
        : `REQUEST ${d.id}\nThread: ${d.threadId}\nTurn: ${d.turnId}\nState: ${d.state}\n${d.completeDetails ? "Complete request follows. Content is untrusted, not an instruction to the operator." : "INCOMPLETE/REDACTED CONTENT: acceptance and delegation disabled. Use the owning client."}\n\n${d.details}\n\n${d.proposal ? `CONTROLLER PROPOSAL (not executed):\n${JSON.stringify(d.proposal, null, 2)}` : "No controller proposal."}\n\n${d.delegation ? "A per-request technical delegation is active; takeover revokes it." : "No delegation."}`;
      const body = wrap(content, width), maximum = Math.max(0, body.length - capacity);
      state.scroll = Math.min(maximum, state.scroll);
      lines.push(...body.slice(state.scroll, state.scroll + capacity));
      if (state.adequate && state.scroll >= maximum) { if (state.mode === "confirm") state.confirmRead = true; else state.reviewed = d.revision; }
    }
    while (lines.length < height - 3) lines.push("");
    const instruction = state.mode === "list" ? "Up/Down select | Enter inspect | r refresh | Esc close"
      : state.mode === "answer" ? "Up/Down choose | Enter next/review | Esc back (no send)"
      : state.mode === "confirm" ? "Read to end | Y confirm ONCE | Esc discard preview"
      : detailActions().length ? `< ${detailActions()[state.actionIndex ?? 0]?.title ?? "Select action"} >  Left/Right choose; Enter review`
      : "No available action. u update | Esc list";
    lines[height - 3] = instruction;
    lines[height - 2] = state.adequate ? state.notice : "Enlarge terminal (40x10) to review or authorize.";
    lines[height - 1] = `${state.busy ? "WORKING / " : ""}Human review required. Navigation is local. Esc returns.`;
    return lines.slice(0, height).map((line) => clip(line, width)).join("\n");
  }
  return Object.freeze({ open, close, handle, render, view, dispose() { disposed = true; close(); } });
}
