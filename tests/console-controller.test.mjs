import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConsoleController,
  runConsole
} from "../plugins/fleet/scripts/lib/console-controller.mjs";

function lane(overrides = {}) {
  return {
    id: "lane-a",
    role: "investigator",
    label: "Inspect the runtime",
    model: "gpt-5.6-sol",
    effort: "high",
    status: "running",
    phase: "inspect",
    authority: {
      sandbox: "read-only",
      network: "off",
      browser: { inspect: false, mutate: false },
      process: { start: true, stopOwned: false },
      database: { read: false, write: false },
      externalEffects: { send: false, payment: false, deploy: false, delete: false },
      retry: false
    },
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    workspace: { name: "fleet-test", branch: "main" },
    runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
    lanes: [lane(), lane({ id: "lane-b", status: "queued" })],
    updatedAt: "2026-08-17T12:00:00.000Z",
    ...overrides
  };
}

function fakeIo() {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const writes = [];
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
  };
  stdin.resume = () => undefined;
  stdin.pause = () => undefined;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 28;
  stdout.write = (value) => {
    writes.push(String(value));
    return true;
  };
  return { stdin, stdout, lifecycle: new EventEmitter(), writes };
}

function idleClock() {
  let callback = null;
  return {
    setInterval(fn) {
      callback = fn;
      return 1;
    },
    clearInterval() {
      callback = null;
    },
    tick() {
      callback?.();
    }
  };
}

function recordingRuntime() {
  const calls = [];
  return {
    calls,
    async followUp(...args) {
      calls.push(["followUp", ...args]);
    },
    async cancel(...args) {
      calls.push(["cancel", ...args]);
    },
    async retry(...args) {
      calls.push(["retry", ...args]);
    }
  };
}

async function emitAfterStart(io, chunk) {
  await new Promise((resolve) => setImmediate(resolve));
  io.stdin.emit("data", Buffer.from(chunk));
}

test("viewing and navigation never invoke a model operation", async () => {
  const io = fakeIo();
  const runtime = recordingRuntime();
  const running = runConsole({
    cwd: process.cwd(),
    io,
    runtime,
    clock: idleClock(),
    readSnapshot: async () => snapshot(),
    terminalSession: async (_io, run) => run({ signal: new AbortController().signal })
  });

  await emitAfterStart(io, "\u001b[B\tq");
  await running;

  assert.deepEqual(runtime.calls, []);
});

test("opening the preserved editor passes the untouched Claude draft", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-console-draft-"));
  const draftPath = path.join(root, "draft.txt");
  await fs.writeFile(draftPath, "keep this prompt", "utf8");
  const io = fakeIo();
  const editorArgs = [];
  const running = runConsole({
    cwd: process.cwd(),
    draftPath,
    io,
    clock: idleClock(),
    readSnapshot: async () => snapshot(),
    spawnEditor: async (value) => {
      editorArgs.push(value);
    },
    terminalSession: async (_io, run) => run({ signal: new AbortController().signal })
  });

  await emitAfterStart(io, "eq");
  await running;

  assert.deepEqual(editorArgs, [draftPath]);
  assert.equal(await fs.readFile(draftPath, "utf8"), "keep this prompt");
});

test("formation advances only for active lanes and pauses without polling faster", async () => {
  const writes = [];
  const controller = createConsoleController({
    snapshot: snapshot(),
    readSnapshot: async () => snapshot(),
    write: (value) => writes.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.render();
  await controller.dispatch({ type: "tick" });
  const afterMotion = writes.length;
  await controller.dispatch({ type: "toggleMotion" });
  await controller.dispatch({ type: "tick" });

  assert.equal(afterMotion, 2);
  assert.equal(writes.length, 3);
  assert.equal(controller.state().motion, false);
});

test("complete lanes keep a subtle awaiting-verification motion until paused", async () => {
  const writes = [];
  const complete = snapshot({ lanes: [lane({ status: "complete", phase: "complete" })] });
  const controller = createConsoleController({
    snapshot: complete,
    readSnapshot: async () => complete,
    write: (value) => writes.push(value),
    terminal: { columns: 160, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.render();
  await controller.dispatch({ type: "tick" });
  assert.equal(writes.length, 2);

  await controller.dispatch({ type: "toggleMotion" });
  assert.match(controller.state().notice, /MOTION PAUSED/iu);
  const pausedWrites = writes.length;
  await controller.dispatch({ type: "tick" });
  assert.equal(writes.length, pausedWrites);
});

test("wide panel navigation changes visible focus instead of only internal state", async () => {
  const writes = [];
  const controller = createConsoleController({
    snapshot: snapshot(),
    write: (value) => writes.push(value),
    terminal: { columns: 160, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.render();
  await controller.dispatch({ type: "activate" });
  assert.match(writes.at(-1), /\[DETAIL\]/u);
  await controller.dispatch({ type: "help" });
  assert.match(writes.at(-1), /\[CONTROLS\]/u);
});

test("single-lane movement reports why selection did not change", async () => {
  const controller = createConsoleController({
    snapshot: snapshot({ lanes: [lane()] }),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "move", delta: 1 });

  assert.equal(controller.state().selectedIndex, 0);
  assert.match(controller.state().notice, /ONLY 1 LANE/iu);
});

test("denied cancellation shows the authority reason and never calls runtime", async () => {
  const writes = [];
  const runtime = recordingRuntime();
  const controller = createConsoleController({
    snapshot: snapshot(),
    runtime,
    write: (value) => writes.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.render();
  await controller.dispatch({ type: "cancel" });
  await controller.dispatch({ type: "confirm" });

  assert.deepEqual(runtime.calls, []);
  assert.match(writes.at(-1), /owned-process-stop-not-authorized/);
});

test("owned cancellation runs only after the visible confirmation", async () => {
  const runtime = recordingRuntime();
  const owned = lane({ turnId: "owned-turn-a" });
  owned.threadId = "owned-thread-a";
  owned.authority = {
    ...owned.authority,
    process: { start: true, stopOwned: true }
  };
  const controller = createConsoleController({
    snapshot: snapshot({ lanes: [owned] }),
    runtime,
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "cancel" });
  assert.deepEqual(runtime.calls, []);
  await controller.dispatch({ type: "confirm" });

  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0][0], "cancel");
  assert.equal(runtime.calls[0][1].id, "lane-a");
  assert.deepEqual(runtime.calls[0][2], {
    threadId: "owned-thread-a",
    turnId: "owned-turn-a"
  });
});

test("message opens a bounded composer and submits text without triggering shortcuts", async () => {
  const runtime = recordingRuntime();
  const completed = lane({ status: "complete", phase: "complete" });
  const writes = [];
  const controller = createConsoleController({
    snapshot: snapshot({ lanes: [completed, lane({ id: "lane-b" })] }),
    runtime,
    write: (value) => writes.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "message" });
  assert.deepEqual(runtime.calls, []);
  assert.equal(controller.state().composer.laneId, "lane-a");
  await controller.dispatch({ type: "text", value: "j" });
  await controller.dispatch({ type: "text", value: "m" });
  await controller.dispatch({ type: "backspace" });
  await controller.dispatch({ type: "submitMessage" });

  assert.equal(controller.state().selectedIndex, 0);
  assert.equal(controller.state().composer, null);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0][0], "followUp");
  assert.equal(runtime.calls[0][1].id, "lane-a");
  assert.equal(runtime.calls[0][2], "j");
  assert.match(writes.join("\n"), /FOLLOW-UP/i);
  assert.match(controller.state().notice, /EXISTING CODEX THREAD/iu);
});

test("completed lanes refuse misleading cancellation previews", async () => {
  const controller = createConsoleController({
    snapshot: snapshot({ lanes: [lane({ status: "complete", phase: "complete" })] }),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "cancel" });

  assert.equal(controller.state().confirmation, null);
  assert.match(controller.state().notice, /ALREADY COMPLETE|NOTHING TO CANCEL/iu);
});

test("composer Escape discards text without invoking the runtime", async () => {
  const runtime = recordingRuntime();
  const controller = createConsoleController({
    snapshot: snapshot({ lanes: [lane({ status: "complete" })] }),
    runtime,
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "message" });
  await controller.dispatch({ type: "text", value: "do not send" });
  await controller.dispatch({ type: "discardMessage" });

  assert.equal(controller.state().composer, null);
  assert.deepEqual(runtime.calls, []);
});

test("one terminal chunk can enter composer, type, submit, and return safely", async () => {
  const io = fakeIo();
  const runtime = recordingRuntime();
  const running = runConsole({
    cwd: process.cwd(),
    io,
    runtime,
    clock: idleClock(),
    readSnapshot: async () => snapshot({
      lanes: [lane({ status: "complete", phase: "complete" })]
    }),
    terminalSession: async (_io, run) => run({ signal: new AbortController().signal })
  });

  await emitAfterStart(io, "mhello\rq");
  await running;

  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0][0], "followUp");
  assert.equal(runtime.calls[0][2], "hello");
});

test("cancellation refuses a lane whose pinned turn changed before confirmation", async () => {
  const runtime = recordingRuntime();
  const first = lane({
    threadId: "owned-thread-a",
    turnId: "owned-turn-a",
    authority: {
      ...lane().authority,
      process: { start: true, stopOwned: true }
    }
  });
  let current = snapshot({ lanes: [first] });
  const writes = [];
  const controller = createConsoleController({
    snapshot: current,
    readSnapshot: async () => current,
    runtime,
    write: (value) => writes.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "cancel" });
  current = snapshot({
    lanes: [{ ...first, turnId: "owned-turn-b" }]
  });
  await controller.dispatch({ type: "tick" });
  await controller.dispatch({ type: "confirm" });

  assert.deepEqual(runtime.calls, []);
  assert.match(writes.at(-1), /confirmation-target-changed/);
});

test("filter mode narrows lanes without treating typed J and K as navigation", async () => {
  const writes = [];
  const controller = createConsoleController({
    snapshot: snapshot({
      lanes: [lane({ id: "lane-j" }), lane({ id: "lane-k" })]
    }),
    write: (value) => writes.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "filter" });
  await controller.dispatch({ type: "text", value: "k" });
  await controller.dispatch({ type: "applyFilter" });

  assert.equal(controller.state().laneCount, 1);
  assert.match(writes.at(-1), /lane-k/);
  assert.doesNotMatch(writes.at(-1), /lane-j/);
});

test("copy uses bounded OSC 52 and leaves a visible identifier fallback", async () => {
  const controls = [];
  const writes = [];
  const controller = createConsoleController({
    snapshot: snapshot({ lanes: [lane()] }),
    write: (value) => writes.push(value),
    writeControl: (value) => controls.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.dispatch({ type: "confirm" });

  assert.equal(controls[0], `\u001b]52;c;${Buffer.from("lane-a").toString("base64")}\u0007`);
  assert.match(writes.at(-1), /COPY lane-a/);
});

test("unchanged inactive snapshots do not redraw on fallback ticks", async () => {
  const writes = [];
  const complete = snapshot({ lanes: [lane({ status: "verified" })] });
  const controller = createConsoleController({
    snapshot: complete,
    readSnapshot: async () => complete,
    write: (value) => writes.push(value),
    terminal: { columns: 100, rows: 28 },
    preferences: { color: false, unicode: true }
  });

  await controller.render();
  await controller.dispatch({ type: "tick" });
  await controller.dispatch({ type: "tick" });

  assert.equal(writes.length, 1);
});
