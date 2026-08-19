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
  assert.deepEqual(ownership.originalEditorCommand, ["nvim"]);
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
    assert.match(launcher, /FLEET_ORIGINAL_EDITOR_JSON/);
    assert.match(launcher, /FLEET_INTEGRATION_VERSION/);
    assert.match(launcher, /0\.1\.0/);
    assert.match(launcher, /null/);
    assert.match(launcher, /"%\*"|"\$@"|%\*/);
    assert.equal(ownership.restartRequired, true);
  });
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("setup launcher carries the prior editor as bounded argv JSON", async (t) => {
  const scope = await fixture(t, "win32");
  await writeSettings(scope, { env: { VISUAL: '"C:\\Program Files\\Editor\\editor.exe" --wait' } });

  const plan = await previewSetup(scope);
  await applySetup({ ...plan, confirmation: plan.confirmationToken });
  const ownership = await readOwnership(scope);
  const launcher = await fs.readFile(ownership.launcherPath, "utf8");

  assert.deepEqual(ownership.originalEditorCommand, [
    "C:\\Program Files\\Editor\\editor.exe",
    "--wait"
  ]);
  assert.ok(launcher.includes(JSON.stringify(ownership.originalEditorCommand)));
});

test("setup aborts without overwriting a late settings change", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const plan = await previewSetup(scope);

  await assert.rejects(
    applySetup(
      { ...plan, confirmation: plan.confirmationToken },
      { beforeSettingsCommit: () => writeSettings(scope, { env: { EDITOR: "code --wait" } }) }
    ),
    /changed while setup was being prepared/i
  );

  assert.equal((await readSettings(scope)).env.EDITOR, "code --wait");
  assert.equal(await exists(plan.runtimeTargetDir), false);
  assert.equal(await exists(plan.launcherPath), false);
  assert.equal(await exists(path.join(scope.pluginDataDir, "ownership.json")), false);
});

test("setup rolls settings and owned files back when final manifest write fails", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { theme: "dark", env: { EDITOR: "nvim" } });
  const plan = await previewSetup(scope);
  let writes = 0;
  const writeJson = async (filePath, value) => {
    writes += 1;
    if (writes === 3) throw new Error("simulated final manifest failure");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  await assert.rejects(
    applySetup(
      { ...plan, confirmation: plan.confirmationToken },
      { atomicWriteJson: writeJson }
    ),
    /simulated final manifest failure/i
  );

  assert.deepEqual(await readSettings(scope), { theme: "dark", env: { EDITOR: "nvim" } });
  assert.equal(await exists(plan.runtimeTargetDir), false);
  assert.equal(await exists(plan.launcherPath), false);
  assert.equal(await exists(path.join(scope.pluginDataDir, "ownership.json")), false);
});

test("setup upgrades an intact Fleet-owned runtime without losing original editor ownership", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, {
    theme: "dark",
    env: { EDITOR: "nvim", CUSTOM_FLAG: "keep-me" }
  });
  const initial = await previewSetup(scope);
  await applySetup({ ...initial, confirmation: initial.confirmationToken });
  const originalOwnership = await readOwnership(scope);

  await fs.writeFile(
    path.join(scope.runtimeSourceDir, "fleet-console.mjs"),
    "process.stdout.write('fleet-0.1.6');\n",
    "utf8"
  );
  const upgrade = await previewSetup({ ...scope, version: "0.1.6" });

  assert.equal(upgrade.mode, "upgrade");
  assert.equal(upgrade.previousVersion, "0.1.0");
  assert.deepEqual(upgrade.originalValues, originalOwnership.originalValues);
  assert.equal(upgrade.settingsAfter.env.EDITOR, originalOwnership.writtenValues.EDITOR);
  assert.equal(upgrade.settingsAfter.env.VISUAL, originalOwnership.writtenValues.VISUAL);

  const result = await applySetup({ ...upgrade, confirmation: upgrade.confirmationToken });
  const upgradedOwnership = await readOwnership(scope);
  const upgradedRuntime = await fs.readFile(
    path.join(upgradedOwnership.runtimeTargetDir, "fleet-console.mjs"),
    "utf8"
  );

  assert.equal(result.mode, "upgrade");
  assert.equal(upgradedOwnership.version, "0.1.6");
  assert.deepEqual(upgradedOwnership.originalValues, originalOwnership.originalValues);
  assert.equal(upgradedRuntime, "process.stdout.write('fleet-0.1.6');\n");
  assert.equal((await readSettings(scope)).env.CUSTOM_FLAG, "keep-me");
});

test("setup upgrade refuses a launcher whose Fleet ownership evidence changed", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const initial = await previewSetup(scope);
  await applySetup({ ...initial, confirmation: initial.confirmationToken });
  const ownership = await readOwnership(scope);
  await fs.writeFile(ownership.launcherPath, "@echo off\necho replaced\n", "utf8");

  await assert.rejects(
    previewSetup({ ...scope, version: "0.1.6" }),
    /launcher.*no longer owned|ownership.*launcher/i
  );
  assert.equal((await readOwnership(scope)).version, "0.1.0");
});

test("setup upgrade refuses an accidental runtime downgrade", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const initial = await previewSetup({ ...scope, version: "0.2.0" });
  await applySetup({ ...initial, confirmation: initial.confirmationToken });

  await assert.rejects(
    previewSetup({ ...scope, version: "0.1.6" }),
    /downgrade.*refused/iu
  );
  assert.equal((await readOwnership(scope)).version, "0.2.0");
});

test("upgrade rollback restores a manifest written before its writer throws", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const initial = await previewSetup(scope);
  await applySetup({ ...initial, confirmation: initial.confirmationToken });
  const original = await readOwnership(scope);
  await fs.writeFile(
    path.join(scope.runtimeSourceDir, "fleet-console.mjs"),
    "process.stdout.write('upgraded');\n",
    "utf8"
  );
  const upgrade = await previewSetup({ ...scope, version: "0.1.6" });

  await assert.rejects(
    applySetup(
      { ...upgrade, confirmation: upgrade.confirmationToken },
      {
        atomicWriteJson: async (filePath, value) => {
          await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
          throw new Error("writer failed after replacement");
        }
      }
    ),
    /writer failed after replacement/iu
  );

  assert.deepEqual(await readOwnership(scope), original);
  assert.equal(await exists(upgrade.runtimeTargetDir), false);
  assert.equal(
    await fs.readFile(original.launcherPath, "utf8"),
    upgrade.launcherContent.replaceAll("0.1.6", "0.1.0")
  );
});

test("upgrade rollback preserves recovery artifacts when launcher restore fails", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const initial = await previewSetup(scope);
  await applySetup({ ...initial, confirmation: initial.confirmationToken });
  await fs.writeFile(
    path.join(scope.runtimeSourceDir, "fleet-console.mjs"),
    "process.stdout.write('upgraded');\n",
    "utf8"
  );
  const upgrade = await previewSetup({ ...scope, version: "0.1.6" });
  let launcherWrites = 0;

  await assert.rejects(
    applySetup(
      { ...upgrade, confirmation: upgrade.confirmationToken },
      {
        atomicWrite: async (filePath, contents, mode) => {
          if (filePath === upgrade.launcherPath) {
            launcherWrites += 1;
            if (launcherWrites === 2) throw new Error("launcher restore failed");
          }
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, contents, { mode });
        },
        atomicWriteJson: async () => {
          throw new Error("final manifest failed");
        }
      }
    ),
    /rollback incomplete.*launcher restore failed/iu
  );

  assert.equal(await exists(upgrade.runtimeTargetDir), true);
});

test("upgrade rollback never overwrites a concurrently changed ownership manifest", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const initial = await previewSetup(scope);
  await applySetup({ ...initial, confirmation: initial.confirmationToken });
  await fs.writeFile(
    path.join(scope.runtimeSourceDir, "fleet-console.mjs"),
    "process.stdout.write('upgraded');\n",
    "utf8"
  );
  const upgrade = await previewSetup({ ...scope, version: "0.1.6" });
  const concurrent = { schemaVersion: 1, status: "applied", owner: "concurrent-change" };

  await assert.rejects(
    applySetup(
      { ...upgrade, confirmation: upgrade.confirmationToken },
      {
        atomicWriteJson: async (filePath) => {
          await fs.writeFile(filePath, `${JSON.stringify(concurrent)}\n`, "utf8");
          throw new Error("concurrent manifest detected");
        }
      }
    ),
    /rollback incomplete.*ownership changed concurrently/iu
  );

  assert.deepEqual(await readOwnership(scope), concurrent);
  assert.equal(await exists(upgrade.runtimeTargetDir), true);
});

test("uninstall removes every intact runtime retained across Fleet upgrades", async (t) => {
  const scope = await fixture(t);
  await writeSettings(scope, { env: { EDITOR: "nvim" } });
  const initial = await previewSetup(scope);
  await applySetup({ ...initial, confirmation: initial.confirmationToken });
  const originalRuntime = (await readOwnership(scope)).runtimeTargetDir;

  await fs.writeFile(
    path.join(scope.runtimeSourceDir, "fleet-console.mjs"),
    "process.stdout.write('upgraded');\n",
    "utf8"
  );
  const upgrade = await previewSetup({ ...scope, version: "0.1.6" });
  await applySetup({ ...upgrade, confirmation: upgrade.confirmationToken });
  const upgradedOwnership = await readOwnership(scope);
  const upgradedRuntime = upgradedOwnership.runtimeTargetDir;
  const preview = await previewUninstallSetup(scope);

  assert.deepEqual(
    new Set(preview.remove),
    new Set([originalRuntime, upgradedRuntime, upgradedOwnership.launcherPath])
  );
  await uninstallSetup({ ...scope, confirmationToken: preview.confirmationToken });
  assert.equal(await exists(originalRuntime), false);
  assert.equal(await exists(upgradedRuntime), false);
});
