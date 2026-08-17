import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { withTerminalSession } from "../plugins/fleet/scripts/lib/tui-session.mjs";

function fakeTerminal({ rawMode = false } = {}) {
  const lifecycle = new EventEmitter();
  const writes = [];
  const rawChanges = [];
  let resumed = 0;
  let paused = 0;

  const stdin = {
    isTTY: true,
    isRaw: rawMode,
    setRawMode(value) {
      this.isRaw = value;
      rawChanges.push(value);
    },
    resume() {
      resumed += 1;
    },
    pause() {
      paused += 1;
    }
  };
  const stdout = {
    isTTY: true,
    write(value) {
      writes.push(String(value));
      return true;
    }
  };

  return {
    stdin,
    stdout,
    lifecycle,
    output: () => writes.join(""),
    rawChanges,
    counts: () => ({ resumed, paused })
  };
}

test("terminal restores modes when the dashboard throws", async () => {
  const io = fakeTerminal();

  await assert.rejects(
    withTerminalSession(io, async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  assert.equal(io.stdin.isRaw, false);
  assert.deepEqual(io.rawChanges, [true, false]);
  assert.match(io.output(), /\u001b\[\?1049h/);
  assert.match(io.output(), /\u001b\[\?1006h/);
  assert.match(io.output(), /\u001b\[\?1006l/);
  assert.match(io.output(), /\u001b\[\?25h/);
  assert.match(io.output(), /\u001b\[\?1049l/);
});

test("normal return restores prior raw mode and removes lifecycle listeners", async () => {
  const io = fakeTerminal({ rawMode: true });
  const result = await withTerminalSession(io, async () => "done");

  assert.equal(result, "done");
  assert.equal(io.stdin.isRaw, true);
  assert.deepEqual(io.rawChanges, [true, true]);
  assert.deepEqual(io.counts(), { resumed: 1, paused: 1 });
  for (const event of ["SIGINT", "SIGTERM", "exit"]) {
    assert.equal(io.lifecycle.listenerCount(event), 0);
  }
});

test("suspended editor receives a normal terminal and Fleet resumes afterward", async () => {
  const io = fakeTerminal();

  await withTerminalSession(io, async ({ suspend }) => {
    assert.equal(io.stdin.isRaw, true);
    await suspend(async () => {
      assert.equal(io.stdin.isRaw, false);
    });
    assert.equal(io.stdin.isRaw, true);
  });

  assert.deepEqual(io.rawChanges, [true, false, true, false]);
  assert.deepEqual(io.counts(), { resumed: 2, paused: 2 });
  assert.equal((io.output().match(/\u001b\[\?1049h/g) ?? []).length, 2);
  assert.equal((io.output().match(/\u001b\[\?1049l/g) ?? []).length, 2);
});

test("signal restoration is immediate and idempotent", async () => {
  const io = fakeTerminal();
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });

  const session = withTerminalSession(io, async () => waiting);
  io.lifecycle.emit("SIGINT");
  io.lifecycle.emit("SIGTERM");
  release("stopped");

  assert.equal(await session, "stopped");
  assert.equal(io.stdin.isRaw, false);
  assert.equal((io.output().match(/\u001b\[\?1049l/g) ?? []).length, 1);
});

test("non-interactive streams fail before changing terminal state", async () => {
  const io = fakeTerminal();
  io.stdout.isTTY = false;

  await assert.rejects(
    withTerminalSession(io, async () => "never"),
    /interactive TTY/
  );

  assert.deepEqual(io.rawChanges, []);
  assert.equal(io.output(), "");
});
