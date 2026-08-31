import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { checkLocalLinks } from "../scripts/check-doc-links.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);
const REQUIRED = [
  "ARCHITECTURE.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "docs/THREAT_MODEL.md",
  "docs/TROUBLESHOOTING.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/pull_request_template.md",
  "docs/assets/fleet-console-dashboard.gif",
  "docs/assets/fleet-console-session.png"
];

test("public project surface contains the release support files", async () => {
  for (const relativePath of REQUIRED) {
    const metadata = await fs.stat(path.join(ROOT, relativePath));
    assert.equal(metadata.isFile(), true, relativePath);
    assert.ok(metadata.size > 0, relativePath);
  }
});

test("README shows a verified console asset and links the operating guides", async () => {
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");

  assert.match(readme, /docs\/assets\/fleet-console-dashboard\.gif/u);
  assert.match(readme, /docs\/assets\/fleet-console-session\.png/u);
  assert.match(readme, /ARCHITECTURE\.md/u);
  assert.match(readme, /SECURITY\.md/u);
  assert.match(readme, /CONTRIBUTING\.md/u);
  assert.match(readme, /THREAT_MODEL\.md/u);
  assert.match(readme, /TROUBLESHOOTING\.md/u);
});

test("preview renderer emits the dashboard and embedded Codex session surfaces", async () => {
  const project = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const { stdout } = await run(process.execPath, ["scripts/render-console-preview.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.previews.dashboard.columns, 160);
  assert.equal(payload.previews.dashboard.rows, 28);
  assert.equal(payload.previews.dashboard.frames.length, 4);
  const escapedVersion = project.version.replaceAll(".", "\\.");
  assert.match(payload.previews.dashboard.frames[0], new RegExp(`FLEET//OPS\\s+v${escapedVersion}`, "u"));
  assert.equal(payload.previews.session.columns, 140);
  assert.equal(payload.previews.session.rows, 30);
  assert.match(payload.previews.session.frame, /FLEET\/\/CODEX SESSION/u);
  assert.match(payload.previews.session.frame, /\[YOU\]/u);
  assert.match(payload.previews.session.frame, /\[CODEX\]/u);
  assert.match(payload.previews.session.frame, /COMPOSE \[FOLLOW-UP\]/u);
  assert.match(payload.previews.session.frame, /Enter: Send.*Ctrl\+G: Dashboard/u);
});

test("every local Markdown link resolves inside the repository", async () => {
  const report = await checkLocalLinks(ROOT);

  assert.equal(report.ok, true, JSON.stringify(report.broken));
});

test("public guidance names scalable status and readable result commands", async () => {
  const [readme, troubleshooting] = await Promise.all([
    fs.readFile(path.join(ROOT, "README.md"), "utf8"),
    fs.readFile(path.join(ROOT, "docs", "TROUBLESHOOTING.md"), "utf8")
  ]);

  assert.match(readme, /PageUp.*PageDown.*Home.*End/is);
  assert.match(troubleshooting, /status --all/iu);
  assert.match(troubleshooting, /result --summary/iu);
});
