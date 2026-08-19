import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_LANES,
  MAX_STATE_BYTES,
  readWorkspaceState,
  writeWorkspaceState
} from "../plugins/fleet/scripts/lib/safe-state.mjs";

async function stateRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "fleet-state-"));
}

function fixtureState(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: "2026-08-17T12:00:00.000Z",
    lanes: [],
    ...overrides
  };
}

test("state round trip is atomic and sanitizes lane metadata", async () => {
  const root = await stateRoot();
  await writeWorkspaceState(root, fixtureState({
    lanes: [{
      id: "lane-1",
      label: "user@example.com",
      prompt: "do not persist me",
      tokenUsage: { input: 12, output: 3 }
    }]
  }));

  const stored = await readWorkspaceState(root);
  const files = await fs.readdir(root);
  assert.equal(stored.lanes.length, 1);
  assert.match(stored.lanes[0].label, /\[REDACTED:EMAIL\]/);
  assert.equal(stored.lanes[0].prompt, undefined);
  assert.equal(stored.lanes[0].tokenUsage.input, 12);
  assert.deepEqual(files, ["state.json"]);
});

test("Windows transient atomic replace failures are retried within a bound", async () => {
  const root = await stateRoot();
  const delays = [];
  let attempts = 0;

  await writeWorkspaceState(root, fixtureState(), {
    platform: "win32",
    rename: async (source, destination) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("transient hosted-runner file lock");
        error.code = "EPERM";
        throw error;
      }
      await fs.rename(source, destination);
    },
    sleep: async (milliseconds) => delays.push(milliseconds)
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(await readWorkspaceState(root), fixtureState());
});

test("state refuses excessive lane count and serialized size", async () => {
  const root = await stateRoot();
  await assert.rejects(
    writeWorkspaceState(root, fixtureState({ lanes: Array.from({ length: MAX_LANES + 1 }, () => ({})) })),
    /lane limit/i
  );
  await assert.rejects(
    writeWorkspaceState(root, fixtureState({ lanes: [{ label: "x".repeat(MAX_STATE_BYTES) }] })),
    /state size/i
  );
});

test("unknown schemas fail closed", async () => {
  const root = await stateRoot();
  await assert.rejects(
    writeWorkspaceState(root, fixtureState({ schemaVersion: 99 })),
    /schema version/i
  );
});

test("corrupt state is quarantined and replaced by an empty snapshot", async () => {
  const root = await stateRoot();
  await fs.writeFile(path.join(root, "state.json"), "{broken", "utf8");

  const state = await readWorkspaceState(root, { now: () => 1786968000000 });
  const files = await fs.readdir(root);
  assert.deepEqual(state, { schemaVersion: 1, lanes: [], updatedAt: null });
  assert.equal(files.some((name) => /^state\.corrupt-1786968000000\.json$/.test(name)), true);
});

test("a symlink workspace state root is rejected", async (t) => {
  const parent = await stateRoot();
  const target = await stateRoot();
  const link = path.join(parent, "linked");
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Symlink creation is unavailable in this Windows environment.");
      return;
    }
    throw error;
  }

  await assert.rejects(writeWorkspaceState(link, fixtureState()), /symbolic link/i);
});

test("a symlink ancestor cannot redirect a new workspace state directory", async (t) => {
  const parent = await stateRoot();
  const target = await stateRoot();
  const link = path.join(parent, "linked-parent");
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Symlink creation is unavailable in this Windows environment.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    writeWorkspaceState(path.join(link, "new-workspace"), fixtureState()),
    /symbolic link/i
  );
  await assert.rejects(fs.access(path.join(target, "new-workspace")), /ENOENT/);
});
