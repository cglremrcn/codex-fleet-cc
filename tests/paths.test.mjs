import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getFleetDataDir,
  resolveOwnedPath,
  workspaceKey
} from "../plugins/fleet/scripts/lib/paths.mjs";

test("fleet data directory follows each platform convention", () => {
  assert.equal(
    getFleetDataDir({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "win32", "C:\\Users\\Ada"),
    "C:\\Users\\Ada\\AppData\\Local\\codex-fleet-cc"
  );
  assert.equal(
    getFleetDataDir({}, "darwin", "/Users/ada"),
    "/Users/ada/Library/Application Support/codex-fleet-cc"
  );
  assert.equal(
    getFleetDataDir({ XDG_STATE_HOME: "/state/ada" }, "linux", "/home/ada"),
    "/state/ada/codex-fleet-cc"
  );
  assert.equal(
    getFleetDataDir({}, "linux", "/home/ada"),
    "/home/ada/.local/state/codex-fleet-cc"
  );
});

test("relative platform state roots are rejected", () => {
  assert.throws(
    () => getFleetDataDir({ XDG_STATE_HOME: "relative/state" }, "linux", "/home/ada"),
    /absolute/i
  );
  assert.throws(() => getFleetDataDir({}, "win32", "C:\\Users\\Ada"), /LOCALAPPDATA/);
});

test("workspace keys are deterministic without exposing canonical paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-paths-"));
  const first = await workspaceKey(root);
  const second = await workspaceKey(path.join(root, "."));

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(first, /fleet-paths/i);
});

test("owned path resolution rejects traversal outside the fleet data root", () => {
  const root = path.resolve(os.tmpdir(), "fleet-owned-root");

  assert.equal(resolveOwnedPath(root, "workspaces", "abc"), path.join(root, "workspaces", "abc"));
  assert.throws(() => resolveOwnedPath(root, "..", "outside"), /outside owned data root/i);
  assert.throws(() => resolveOwnedPath(root, path.parse(root).root), /outside owned data root/i);
});
