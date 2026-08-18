import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applySetup,
  previewSetup,
  previewUninstallSetup,
  uninstallSetup
} from "../plugins/fleet/scripts/lib/setup.mjs";

async function fixture(t, platform = "win32") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fleet-setup-"));
  const claudeDir = path.join(root, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const pluginDataDir = path.join(root, "plugin-data");
  const runtimeSourceDir = path.join(root, "runtime-source");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(runtimeSourceDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeSourceDir, "fleet-console.mjs"),
    "process.exitCode = 0;\n",
    "utf8"
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    platform,
    settingsPath,
    pluginDataDir,
    runtimeSourceDir,
    version: "0.1.0",
    nodeExecutable: process.execPath,
    now: () => 1_787_000_000_000
  };
}

async function writeSettings(scope, value) {
  await fs.writeFile(scope.settingsPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readSettings(scope) {
  return JSON.parse(await fs.readFile(scope.settingsPath, "utf8"));
}

async function readOwnership(scope) {
  return JSON.parse(
    await fs.readFile(path.join(scope.pluginDataDir, "ownership.json"), "utf8")
  );
}

test("setup preview is non-mutating and preserves unrelated settings and prior editor", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, {
    permissions: { deny: ["Read(.env)"] },
    env: { EDITOR: "nvim", CUSTOM_FLAG: "keep-me" }
  });
  const before = await fs.readFile(scope.settingsPath, "utf8");

  const plan = await previewSetup(scope);
  assert.equal(await fs.readFile(scope.settingsPath, "utf8"), before);
  assert.ok(plan.changes.some((change) => change.path === "env.EDITOR"));
  assert.ok(plan.changes.some((change) => change.path === "env.VISUAL"));

  await applySetup({ ...plan, confirmation: plan.confirmationToken });
  const settings = await readSettings(scope);
  const ownership = await readOwnership(scope);

  assert.deepEqual(settings.permissions.deny, ["Read(.env)"]);
  assert.equal(settings.env.CUSTOM_FLAG, "keep-me");
  assert.equal(ownership.originalEditor, "nvim");
  assert.equal(settings.env.EDITOR, settings.env.VISUAL);
  assert.match(settings.env.EDITOR, /fleet-editor\.cmd/i);
  assert.equal(ownership.keybindingsModified, false);
});

test("stale or altered previews cannot be applied", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const plan = await previewSetup(scope);
  await writeSettings(scope, { env: { EDITOR: "code --wait" } });

  await assert.rejects(
    applySetup({ ...plan, confirmation: plan.confirmationToken }),
    /changed since preview/i
  );
  await assert.rejects(
    applySetup({
      ...plan,
      settingsAfter: { env: { EDITOR: "evil" } },
      confirmation: plan.confirmationToken
    }),
    /confirmation token/i
  );
});

test("uninstall refuses to overwrite an editor changed after setup", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const plan = await previewSetup(scope);
  await applySetup({ ...plan, confirmation: plan.confirmationToken });
  const settings = await readSettings(scope);
  settings.env.EDITOR = "code --wait";
  await writeSettings(scope, settings);

  await assert.rejects(previewUninstallSetup(scope), /no longer owned/i);
  assert.equal((await readSettings(scope)).env.EDITOR, "code --wait");
});

test("uninstall restores only owned values and keeps later unrelated changes", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, {
    theme: "dark",
    env: { EDITOR: "nvim", CUSTOM_FLAG: "before" }
  });
  const plan = await previewSetup(scope);
  await applySetup({ ...plan, confirmation: plan.confirmationToken });
  const installed = await readSettings(scope);
  installed.theme = "light";
  installed.env.CUSTOM_FLAG = "after";
  await writeSettings(scope, installed);

  const uninstallPreview = await previewUninstallSetup(scope);
  const result = await uninstallSetup({
    ...scope,
    confirmationToken: uninstallPreview.confirmationToken
  });
  const restored = await readSettings(scope);

  assert.equal(restored.theme, "light");
  assert.equal(restored.env.CUSTOM_FLAG, "after");
  assert.equal(restored.env.EDITOR, "nvim");
  assert.equal("VISUAL" in restored.env, false);
  assert.equal(result.restored, true);
  await assert.rejects(readOwnership(scope), /ENOENT/);
});

for (const [platform, extension, invocation] of [
  ["win32", ".cmd", /@echo off/i],
  ["darwin", ".sh", /#!\/usr\/bin\/env sh/],
  ["linux", ".sh", /#!\/usr\/bin\/env sh/]
]) {
  test(`setup writes a deterministic ${platform} launcher`, async (t) => {
    const scope = await fixture(t, platform);
    await writeSettings(scope, {});
    const plan = await previewSetup(scope);
    await applySetup({ ...plan, confirmation: plan.confirmationToken });
    const ownership = await readOwnership(scope);
    const launcher = await fs.readFile(ownership.launcherPath, "utf8");

    assert.equal(path.extname(ownership.launcherPath), extension);
    assert.match(launcher, invocation);
    assert.match(launcher, /fleet-console\.mjs/);
    assert.match(launcher, /"%\*"|"\$@"|%\*/);
    assert.equal(ownership.restartRequired, true);
  });
}
