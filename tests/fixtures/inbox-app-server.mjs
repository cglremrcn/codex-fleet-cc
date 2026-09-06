// Deterministic JSONL transport fixture: no account, network, tools or inference.
import readline from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ id, result });
let next = 0, current = null, lastReply = null, starts = 0, policies = [];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 0 && !m.method) {
    lastReply = m;
    send({ method: "serverRequest/resolved", params: { threadId: current.threadId, requestId: 0 } });
    const text = JSON.stringify({ outcome: "accomplished", summary: "The exact request was handled.", workPerformed: ["Decoded a client response on the original turn."], evidenceRefs: ["fixture.json"], verification: ["Wire identity and response recorded by fixture."], artifactRefs: [], controllerRequest: null, stopReason: null });
    send({ method: "item/completed", params: { threadId: current.threadId, turnId: current.turnId, item: { id: "result", type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId: current.threadId, turn: { id: current.turnId, status: "completed" } } });
    return;
  }
  if (m.method === "initialize") reply(m.id, { userAgent: "inbox-fixture" });
  else if (m.method === "initialized") return;
  else if (m.method === "thread/start") { next++; reply(m.id, { thread: { id: `thread-${next}` } }); policies.push(m.params.approvalPolicy); }
  else if (m.method === "thread/name/set") reply(m.id, {});
  else if (m.method === "turn/start") {
    starts++; current = { threadId: m.params.threadId, turnId: `turn-${starts}`, itemId: `question-${starts}` }; policies.push(m.params.approvalPolicy);
    // Deliberately arrives BEFORE turn/start response to exercise early identity binding.
    send({ id: 0, method: "item/tool/requestUserInput", params: { ...current, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "approach", header: "Implementation approach", question: "Which pure parser implementation should be used?", isSecret: false, isOther: true, options: [{ label: "Deterministic parser", description: "No model call for parsing." }, { label: "Existing parser", description: "Retain the existing implementation." }] }] } });
    reply(m.id, { turn: { id: current.turnId } });
  } else if (m.method === "test/observation") reply(m.id, { starts, lastReply, policies });
  else if (m.method === "turn/interrupt") { reply(m.id, {}); send({ method: "turn/completed", params: { threadId: current.threadId, turn: { id: current.turnId, status: "interrupted" } } }); }
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "Fixture method not implemented." } });
});
