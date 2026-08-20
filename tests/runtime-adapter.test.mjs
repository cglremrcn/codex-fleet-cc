import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createRuntime } from "../plugins/fleet/scripts/lib/runtime-adapter.mjs";
import { startFakeCodex } from "./fixtures/fake-codex-app-server.mjs";

const WORKSPACE_KEY = "0123456789abcdef0123456789abcdef";

function readOnlyContract(fixture, id, overrides = {}) {
  return {
    id,
    role: "investigator",
    label: `Inspect ${id}`,
    workspaceKey: WORKSPACE_KEY,
    workspacePath: fixture.workspace,
    model: "gpt-5.6-sol",
    effort: "high",
    authority: {
      sandbox: "read-only",
      network: "off",
      process: { start: true, stopOwned: true }
    },
    prompt: `Inspect the bounded surface for ${id}.`,
    ...overrides
  };
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

test("one adapter reuses one broker for two read-only lanes", async (t) => {
  const fixture = startFakeCodex(t);
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-a"));
  await runtime.startLane(readOnlyContract(fixture, "lane-b"));

  await waitFor(
    () => runtime.listLanes(WORKSPACE_KEY).every((lane) => lane.status === "complete"),
    "both lanes to complete"
  );

  assert.equal(fixture.appServerStarts(), 1);
  assert.equal(runtime.listLanes(WORKSPACE_KEY).length, 2);
  assert.deepEqual(fixture.readState().capabilities.optOutNotificationMethods, [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]);
});

test("image-authorized lanes discover and inject the enabled imagegen skill", async (t) => {
  const fixture = startFakeCodex(t);
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-image", {
    authority: {
      sandbox: "workspace-write",
      network: "off",
      process: { start: true, stopOwned: true },
      image: { generate: true, edit: false }
    },
    prompt: "Use $imagegen to create the approved square visual."
  }));
  await waitFor(
    () => runtime.inspectLane("lane-image")?.status === "complete",
    "image lane completion"
  );

  const state = fixture.readState();
  assert.equal(state.skillsListCalls, 1);
  assert.deepEqual(
    state.lastTurnStart.input.filter((item) => item.type === "skill"),
    [{
      type: "skill",
      name: "imagegen",
      path: path.join(fixture.workspace, "system-skills", "imagegen", "SKILL.md")
    }]
  );
});

test("imagegen injection persists across same-thread continuations", async (t) => {
  const fixture = startFakeCodex(t);
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-image-follow-up", {
    authority: {
      sandbox: "workspace-write",
      network: "off",
      process: { start: true, stopOwned: true },
      image: { generate: true, edit: false }
    },
    prompt: "Use $imagegen to create the confirmed visual."
  }));
  const first = await waitFor(
    () => runtime.inspectLane("lane-image-follow-up")?.status === "complete"
      ? runtime.inspectLane("lane-image-follow-up")
      : null,
    "first image turn"
  );
  await runtime.continueLane("lane-image-follow-up", "Generate one approved refinement.");
  await waitFor(
    () => {
      const lane = runtime.inspectLane("lane-image-follow-up");
      return lane?.status === "complete" && lane.turnId !== first.turnId;
    },
    "image follow-up turn"
  );

  const state = fixture.readState();
  assert.equal(state.skillsListCalls, 1);
  assert.equal(state.lastTurnStart.input.at(-1).type, "skill");
  assert.equal(state.lastTurnStart.input.at(-1).name, "imagegen");
});

test("missing imagegen capability fails before a Codex turn is started", async (t) => {
  const fixture = startFakeCodex(t, "imagegen-missing");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await assert.rejects(
    runtime.startLane(readOnlyContract(fixture, "lane-image-missing", {
      authority: {
        sandbox: "workspace-write",
        network: "off",
        process: { start: true, stopOwned: true },
        image: { generate: true, edit: false }
      },
      prompt: "Create the confirmed launch visual."
    })),
    /enabled imagegen skill is unavailable/iu
  );

  const state = fixture.readState();
  assert.equal(state.skillsListCalls, 1);
  assert.equal(state.lastTurnStart, undefined);
  assert.equal(runtime.inspectLane("lane-image-missing").status, "failed");
});

test("a non-system imagegen skill cannot satisfy the image capability gate", async (t) => {
  const fixture = startFakeCodex(t, "imagegen-non-system");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await assert.rejects(
    runtime.startLane(readOnlyContract(fixture, "lane-image-non-system", {
      authority: {
        sandbox: "workspace-write",
        network: "off",
        process: { start: true, stopOwned: true },
        image: { generate: true, edit: false }
      },
      prompt: "Create the confirmed visual."
    })),
    /enabled imagegen skill is unavailable/iu
  );
  assert.equal(fixture.readState().lastTurnStart, undefined);
});

test("non-image lanes do not discover or inject imagegen", async (t) => {
  const fixture = startFakeCodex(t, "imagegen-missing");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-no-image"));
  await waitFor(
    () => runtime.inspectLane("lane-no-image")?.status === "complete",
    "non-image lane completion"
  );

  const state = fixture.readState();
  assert.equal(state.skillsListCalls, undefined);
  assert.equal(state.lastTurnStart.input.some((item) => item.type === "skill"), false);
});

test("runtime requires a structured evidence-bearing outcome", async (t) => {
  const fixture = startFakeCodex(t);
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-structured"));
  const completed = await waitFor(
    () => runtime.inspectLane("lane-structured")?.status === "complete"
      ? runtime.inspectLane("lane-structured")
      : null,
    "structured lane completion"
  );

  assert.equal(fixture.readState().lastTurnStart.structuredOutcome, true);
  assert.equal(completed.outcome, "accomplished");
  assert.match(completed.lastMessage, /handled the requested task/iu);
});

test("redundant plan approval is recovered on the same Codex thread", async (t) => {
  const fixture = startFakeCodex(t, "plan-then-execute");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  const started = await runtime.startLane(readOnlyContract(fixture, "lane-auto-continue"));
  const completed = await waitFor(
    () => runtime.inspectLane("lane-auto-continue")?.status === "complete"
      ? runtime.inspectLane("lane-auto-continue")
      : null,
    "automatic same-thread continuation"
  );
  const thread = fixture.readState().threads.find((item) => item.id === started.threadId);

  assert.equal(thread.turns.length, 2);
  assert.equal(completed.threadId, started.threadId);
  assert.equal(completed.automaticContinuations, 1);
  assert.match(fixture.readState().lastTurnStart.prompt, /already authorizes/iu);
});

test("a genuine authority request blocks for the controller without widening scope", async (t) => {
  const fixture = startFakeCodex(t, "needs-new-authority");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-needs-controller"));
  const blocked = await waitFor(
    () => runtime.inspectLane("lane-needs-controller")?.status === "blocked"
      ? runtime.inspectLane("lane-needs-controller")
      : null,
    "controller attention outcome"
  );

  assert.equal(blocked.phase, "needs-controller");
  assert.equal(blocked.automaticContinuations, 0);
  assert.match(blocked.exitReason, /deployment authority/iu);
  assert.equal(fixture.readState().threads[0].turns.length, 1);
});

test("malformed output from a mutable lane becomes outcome unknown without another turn", async (t) => {
  const fixture = startFakeCodex(t, "invalid-lane-outcome");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-mutable-unknown", {
    authority: {
      sandbox: "workspace-write",
      network: "off",
      process: { start: true, stopOwned: true }
    }
  }));
  const unknown = await waitFor(
    () => runtime.inspectLane("lane-mutable-unknown")?.status === "outcome_unknown"
      ? runtime.inspectLane("lane-mutable-unknown")
      : null,
    "mutable unknown outcome"
  );

  assert.equal(unknown.phase, "outcome_unknown");
  assert.equal(unknown.automaticContinuations, 0);
  assert.equal(fixture.readState().threads[0].turns.length, 1);
});

test("an accepted initial turn with a lost response becomes outcome unknown", async (t) => {
  const fixture = startFakeCodex(t, "accept-turn-without-response");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env,
    requestTimeoutMs: 50
  });
  t.after(() => runtime.close());

  await assert.rejects(
    runtime.startLane(readOnlyContract(fixture, "lane-initial-acceptance-unknown")),
    (error) => error.requestAcceptance === "unknown"
  );
  const lane = runtime.inspectLane("lane-initial-acceptance-unknown");
  assert.equal(lane.status, "outcome_unknown");
  assert.equal(lane.phase, "outcome_unknown");
  assert.equal(fixture.readState().threads[0].turns.length, 1);
});

test("an automatic continuation with a lost response is never repeated", async (t) => {
  const fixture = startFakeCodex(t, "plan-then-accept-without-response");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env,
    requestTimeoutMs: 50
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-auto-acceptance-unknown"));
  const unknown = await waitFor(
    () => runtime.inspectLane("lane-auto-acceptance-unknown")?.status === "outcome_unknown"
      ? runtime.inspectLane("lane-auto-acceptance-unknown")
      : null,
    "automatic continuation acceptance uncertainty"
  );

  assert.equal(unknown.automaticContinuations, 1);
  assert.equal(fixture.readState().threads[0].turns.length, 2);
});

test("a manual continuation with a lost response locks the runtime lane unknown", async (t) => {
  const fixture = startFakeCodex(t, "accept-follow-up-without-response");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env,
    requestTimeoutMs: 50
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-follow-up-acceptance-unknown"));
  await waitFor(
    () => runtime.inspectLane("lane-follow-up-acceptance-unknown")?.status === "complete",
    "initial terminal result"
  );
  await assert.rejects(
    runtime.continueLane("lane-follow-up-acceptance-unknown", "Continue exactly once."),
    (error) => error.requestAcceptance === "unknown"
  );

  const lane = runtime.inspectLane("lane-follow-up-acceptance-unknown");
  assert.equal(lane.status, "outcome_unknown");
  assert.equal(fixture.readState().threads[0].turns.length, 2);
  await assert.rejects(
    runtime.continueLane("lane-follow-up-acceptance-unknown", "Do not duplicate it."),
    /only continue after completion/iu
  );
});

test("a fresh runtime resumes a controller-blocked lane on the same thread", async (t) => {
  const fixture = startFakeCodex(t, "needs-new-authority");
  const firstRuntime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  await firstRuntime.startLane(readOnlyContract(fixture, "lane-controller-resume"));
  const blocked = await waitFor(
    () => firstRuntime.inspectLane("lane-controller-resume")?.status === "blocked"
      ? firstRuntime.inspectLane("lane-controller-resume")
      : null,
    "first controller block"
  );
  await firstRuntime.close();

  const secondRuntime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => secondRuntime.close());
  await secondRuntime.resumeLane(
    blocked,
    fixture.workspace,
    "The controller supplied the missing bounded decision."
  );
  const resumed = await waitFor(
    () => fixture.readState().threads
      .find((thread) => thread.id === blocked.threadId)?.turns.length === 2,
    "controller-blocked same-thread resume"
  );

  assert.equal(resumed, true);
  assert.equal(secondRuntime.inspectLane("lane-controller-resume").threadId, blocked.threadId);
});

test("runtime events are lane-scoped, monotonic, and omit reasoning deltas", async (t) => {
  const fixture = startFakeCodex(t, "with-reasoning");
  const events = [];
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env,
    onEvent: (event) => events.push(event)
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-events"));
  await waitFor(
    () => runtime.inspectLane("lane-events")?.status === "complete",
    "event lane to complete"
  );

  assert.ok(events.length >= 3);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1)
  );
  assert.ok(events.every((event) => event.laneId === "lane-events"));
  assert.ok(events.every((event) => !event.type.toLowerCase().includes("reasoning")));
  assert.ok(events.every((event) => Number.isFinite(Date.parse(event.at))));
});

test("a completed lane can continue on its existing Codex thread", async (t) => {
  const fixture = startFakeCodex(t);
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-follow-up"));
  const first = await waitFor(
    () => runtime.inspectLane("lane-follow-up")?.status === "complete"
      ? runtime.inspectLane("lane-follow-up")
      : null,
    "initial lane turn"
  );
  await runtime.continueLane("lane-follow-up", "Check the remaining edge case.");
  const second = await waitFor(
    () => {
      const lane = runtime.inspectLane("lane-follow-up");
      return lane?.status === "complete" && lane.turnId !== first.turnId ? lane : null;
    },
    "follow-up turn"
  );

  assert.equal(second.threadId, first.threadId);
  assert.equal(fixture.appServerStarts(), 1);
  assert.match(fixture.readState().lastTurnStart.prompt, /remaining edge case/i);
});

test("runtime reads a sanitized same-thread transcript without reasoning content", async (t) => {
  const fixture = startFakeCodex(t, "with-reasoning");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  const started = await runtime.startLane(readOnlyContract(fixture, "lane-session"));
  await waitFor(
    () => runtime.inspectLane("lane-session")?.status === "complete",
    "session lane to complete"
  );
  const session = await runtime.readThread(started.threadId);

  assert.equal(session.threadId, started.threadId);
  assert.equal(session.source, "appServer");
  assert.equal(session.canAcceptDirectInput, true);
  assert.equal(session.messages.some((message) => message.kind === "user"), true);
  assert.equal(session.messages.some((message) => message.kind === "assistant"), true);
  assert.equal(session.messages.some((message) => /reasoning/iu.test(message.text)), false);
  assert.equal(session.messages.some((message) => /private-command|echo/iu.test(message.text)), false);
  assert.equal(session.messages.some((message) => message.text === "COMMAND COMPLETED"), true);
});

test("runtime steers an active owned Codex turn", async (t) => {
  const fixture = startFakeCodex(t, "interruptible-slow-task");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  const started = await runtime.startLane(readOnlyContract(fixture, "lane-steer"));
  const steered = await runtime.steerLane("lane-steer", "Prioritize the source contradiction.");

  assert.equal(steered.threadId, started.threadId);
  assert.equal(steered.turnId, started.turnId);
  assert.deepEqual(fixture.readState().lastTurnSteer, {
    threadId: started.threadId,
    turnId: started.turnId,
    prompt: "Prioritize the source contradiction.",
    input: [{
      type: "text",
      text: "Prioritize the source contradiction.",
      text_elements: []
    }]
  });
});

test("official turn envelopes without threadId resolve through the turn index", async (t) => {
  const fixture = startFakeCodex(t, "official-turn-envelope");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-official-envelope"));
  const completed = await waitFor(
    () => runtime.inspectLane("lane-official-envelope")?.status === "complete"
      ? runtime.inspectLane("lane-official-envelope")
      : null,
    "official turn completion"
  );

  assert.equal(completed.status, "complete");
  assert.match(completed.lastMessage, /handled the requested task/i);
});

test("an explicitly ephemeral lane is not retained by Codex", async (t) => {
  const fixture = startFakeCodex(t, "ephemeral-name-rejected");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  await runtime.startLane(readOnlyContract(fixture, "lane-ephemeral", { ephemeral: true }));

  assert.equal(fixture.readState().threads.at(-1).ephemeral, true);
});

test("a fresh runtime resumes a persisted completed lane", async (t) => {
  const fixture = startFakeCodex(t);
  const firstRuntime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  const started = await firstRuntime.startLane(readOnlyContract(fixture, "lane-fresh-resume"));
  const completed = await waitFor(
    () => firstRuntime.inspectLane("lane-fresh-resume")?.status === "complete"
      ? firstRuntime.inspectLane("lane-fresh-resume")
      : null,
    "persistable first turn"
  );
  await firstRuntime.close();

  const secondRuntime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => secondRuntime.close());
  await secondRuntime.resumeLane(
    completed,
    fixture.workspace,
    "Inspect the second bounded surface."
  );
  const resumed = await waitFor(
    () => {
      const lane = secondRuntime.inspectLane("lane-fresh-resume");
      return lane?.status === "complete" && lane.turnId !== completed.turnId ? lane : null;
    },
    "fresh-runtime follow-up"
  );

  assert.equal(resumed.threadId, started.threadId);
  assert.equal(fixture.appServerStarts(), 2);
  assert.match(fixture.readState().lastTurnStart.prompt, /second bounded surface/i);
});

test("interrupt targets the selected owned lane turn", async (t) => {
  const fixture = startFakeCodex(t, "interruptible-slow-task");
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env
  });
  t.after(() => runtime.close());

  const started = await runtime.startLane(readOnlyContract(fixture, "lane-stop"));
  await runtime.interruptLane("lane-stop");
  const stopped = await waitFor(
    () => runtime.inspectLane("lane-stop")?.status === "cancelled"
      ? runtime.inspectLane("lane-stop")
      : null,
    "interrupted lane"
  );

  assert.deepEqual(fixture.readState().lastInterrupt, {
    threadId: started.threadId,
    turnId: started.turnId
  });
  assert.equal(stopped.status, "cancelled");
});

test("protocol mismatch keeps inspection but blocks runtime mutations", async (t) => {
  const fixture = startFakeCodex(t);
  const runtime = await createRuntime({
    codexCommand: fixture.command,
    dataDir: fixture.dataDir,
    env: fixture.env,
    brokerProtocolVersion: 999
  });
  t.after(() => runtime.close());

  assert.deepEqual(runtime.listLanes(WORKSPACE_KEY), []);
  await assert.rejects(
    runtime.startLane(readOnlyContract(fixture, "lane-version")),
    /protocol version/i
  );
  assert.equal(fixture.appServerStarts(), 1);
});
