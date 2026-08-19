import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { checkLocalLinks } from "../scripts/check-doc-links.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
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
  "docs/assets/fleet-console-kite-v3.gif"
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

  assert.match(readme, /docs\/assets\/fleet-console-kite-v3\.gif/u);
  assert.match(readme, /ARCHITECTURE\.md/u);
  assert.match(readme, /SECURITY\.md/u);
  assert.match(readme, /CONTRIBUTING\.md/u);
  assert.match(readme, /THREAT_MODEL\.md/u);
  assert.match(readme, /TROUBLESHOOTING\.md/u);
});

test("every local Markdown link resolves inside the repository", async () => {
  const report = await checkLocalLinks(ROOT);

  assert.equal(report.ok, true, JSON.stringify(report.broken));
});
