import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLUGIN = path.join(ROOT, "plugins", "fleet");
const SKILLS = [
  "setup",
  "doctor",
  "status",
  "open",
  "cancel",
  "result",
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
  for (const name of ["setup", "cancel", "export", "uninstall"]) {
    const source = await read(`plugins/fleet/skills/${name}/SKILL.md`);
    const metadata = frontmatter(source);
    assert.equal(metadata.name, name);
    assert.equal(metadata["disable-model-invocation"], "true");
    assert.match(source, /exact preview|explicit confirmation|preview token/i);
  }
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
  assert.doesNotMatch(source, /curl|Invoke-WebRequest|Start-Process/);
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
