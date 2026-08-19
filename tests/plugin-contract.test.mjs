import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLUGIN = path.join(ROOT, "plugins", "fleet");
const SESSION_HOOK = path.join(PLUGIN, "scripts", "fleet-session-hook.mjs");
const SKILLS = [
  "setup",
  "doctor",
  "status",
  "open",
  "cancel",
  "result",
  "follow-up",
  "export",
  "uninstall"
];

async function read(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

async function exists(relativePath) {
  try {
    await fs.access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runSessionHook({ workspace, pluginData }) {
  const isolatedHome = path.join(path.dirname(pluginData), "home");
  const isolatedLocalAppData = path.join(path.dirname(pluginData), "local-app-data");
  const isolatedState = path.join(path.dirname(pluginData), "state");
  const result = spawnSync(process.execPath, [SESSION_HOOK], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_PROJECT_DIR: workspace,
      HOME: isolatedHome,
      LOCALAPPDATA: isolatedLocalAppData,
      USERPROFILE: isolatedHome,
      XDG_STATE_HOME: isolatedState,
    },
    input: JSON.stringify({ cwd: workspace, hook_event_name: "SessionStart" }),
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function readTree(root) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(await fs.readFile(child, "utf8"));
    }
  }
  await visit(root);
  return files.join("\n");
}

function frontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  return Object.fromEntries(match[1].split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `Invalid frontmatter line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

test("plugin exposes the public command surface without project-specific content", async () => {
  const manifest = JSON.parse(await read("plugins/fleet/.claude-plugin/plugin.json"));
  assert.equal(manifest.name, "fleet");
  assert.equal(manifest.license, "Apache-2.0");
  for (const name of SKILLS) {
    assert.equal(await exists(`plugins/fleet/skills/${name}/SKILL.md`), true);
  }
  const allText = await readTree(PLUGIN);
  assert.doesNotMatch(allText, /startupai|bizaliriz|b2b-lead-automation/i);
  assert.doesNotMatch(allText, /C:\\Users|\/Users\/|\/home\//);
});

test("marketplace points to the portable Fleet plugin", async () => {
  const marketplace = JSON.parse(await read(".claude-plugin/marketplace.json"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === "fleet");

  assert.equal(marketplace.name, "codex-fleet-cc");
  assert.equal(entry.source, "./plugins/fleet");
  assert.equal(entry.category, "development");
});

test("user-only state changes cannot be invoked autonomously by the model", async () => {
  for (const name of ["cancel", "export", "uninstall"]) {
    const source = await read(`plugins/fleet/skills/${name}/SKILL.md`);
    const metadata = frontmatter(source);
    assert.equal(metadata.name, name);
    assert.equal(metadata["disable-model-invocation"], "true");
    assert.match(source, /exact preview|explicit confirmation|preview token/i);
  }
});

test("setup keeps its preview token internal and asks the user for one plain confirmation", async () => {
  const source = await read("plugins/fleet/skills/setup/SKILL.md");
  const metadata = frontmatter(source);

  assert.equal(metadata.name, "setup");
  assert.equal(metadata["disable-model-invocation"], "false");
  assert.match(source, /explicit(?: confirmation|ly confirms)/i);
  assert.match(source, /keep.*token.*internal|never ask.*copy|do not ask.*paste/is);
  assert.match(source, /--confirm-token.*confirmationToken/is);
  assert.doesNotMatch(source, /using the exact preview token/i);
});

test("read-only commands stay deterministic and use portable plugin paths", async () => {
  for (const name of ["doctor", "status", "open", "result"]) {
    const source = await read(`plugins/fleet/skills/${name}/SKILL.md`);
    const metadata = frontmatter(source);
    assert.equal(metadata.name, name);
    assert.match(source, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.match(source, /fleet\.mjs/);
    assert.doesNotMatch(source, /Bash\(\*\)|allowed-tools:\s*Bash\s*$/m);
  }
});

test("Codex lane agent accepts one immutable contract and only calls Fleet CLI", async () => {
  const source = await read("plugins/fleet/agents/codex-lane.md");
  const metadata = frontmatter(source);

  assert.equal(metadata.name, "codex-lane");
  assert.match(source, /one immutable lane contract/i);
  assert.match(source, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fleet\.mjs/);
  assert.match(source, /Do not invoke Codex directly/i);
  assert.match(source, /background admission/i);
  assert.match(source, /start.*status.*result.*follow-up.*cancel/is);
  assert.match(source, /same Codex thread/i);
  assert.match(source, /already-granted authority/i);
  assert.match(source, /Ctrl\+G/i);
  assert.match(source, /poll.*status.*result/is);
  assert.match(source, /complete.*verified.*blocked.*failed.*cancelled.*outcome_unknown/is);
  assert.doesNotMatch(source, /curl|Invoke-WebRequest|Start-Process/);
});

test("follow-up skill resumes one existing lane without widening authority", async () => {
  const source = await read("plugins/fleet/skills/follow-up/SKILL.md");
  const metadata = frontmatter(source);

  assert.equal(metadata.name, "follow-up");
  assert.match(source, /same Codex thread/i);
  assert.match(source, /already-granted authority/i);
  assert.match(source, /new (scope|authority).*stop/is);
  assert.match(source, /fleet\.mjs" follow-up --stdin --json/i);
});

test("SessionStart hook reconciles status but never starts a lane", async () => {
  const hooks = JSON.parse(await read("plugins/fleet/hooks/hooks.json"));
  const sessionHooks = hooks.hooks.SessionStart;
  assert.equal(Array.isArray(sessionHooks), true);
  assert.match(JSON.stringify(sessionHooks), /fleet-session-hook\.mjs/);

  const source = await read("plugins/fleet/scripts/fleet-session-hook.mjs");
  assert.match(source, /runCli/);
  assert.match(source, /"status"/);
  assert.doesNotMatch(source, /runCli\(\s*\[\s*["']start["']/);
  assert.doesNotMatch(source, /createRuntime|scheduler\.enqueue/);
});

test("SessionStart offers one-confirm setup without mutating user state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-session-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  await fs.mkdir(workspace, { recursive: true });

  const response = runSessionHook({ workspace, pluginData });
  const context = response.hookSpecificOutput?.additionalContext ?? "";

  assert.match(context, /Ctrl\+G Fleet Console/i);
  assert.match(context, /one plain confirmation question/i);
  assert.match(context, /explicitly agrees/i);
  assert.doesNotMatch(context, /[a-f0-9]{64}/i);
  assert.equal(await pathExists(pluginData), false, "the hook must not create plugin state");
  assert.deepEqual(await fs.readdir(workspace), [], "the hook must not create workspace state");
});

test("SessionStart stays silent when Fleet integration ownership is applied", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-session-configured-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(pluginData, { recursive: true });
  const manifest = JSON.parse(await read("plugins/fleet/.claude-plugin/plugin.json"));
  await fs.writeFile(
    path.join(pluginData, "ownership.json"),
    JSON.stringify({ schemaVersion: 1, status: "applied", version: manifest.version }),
    "utf8",
  );

  const response = runSessionHook({ workspace, pluginData });

  assert.equal(response.hookSpecificOutput?.additionalContext, undefined);
});

test("SessionStart reports an outdated Ctrl+G integration runtime to Claude", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-session-outdated-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(pluginData, { recursive: true });
  await fs.writeFile(
    path.join(pluginData, "ownership.json"),
    JSON.stringify({ schemaVersion: 1, status: "applied", version: "0.1.0" }),
    "utf8"
  );

  const response = runSessionHook({ workspace, pluginData });
  const context = response.hookSpecificOutput?.additionalContext ?? "";

  assert.match(context, /integration runtime 0\.1\.0/iu);
  assert.match(context, /installed plugin 0\.1\.6/iu);
  assert.match(context, /Fleet setup.*upgrade/iu);
  assert.equal((await fs.readdir(pluginData)).length, 1, "the hook must remain read-only");
});

test("SessionStart reports a non-file ownership candidate as invalid", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-session-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(pluginData, "ownership.json"), { recursive: true });

  const response = runSessionHook({ workspace, pluginData });
  const context = response.hookSpecificOutput?.additionalContext ?? "";

  assert.match(context, /ownership is unreadable or incomplete/iu);
  assert.match(context, /doctor before setup/iu);
});
