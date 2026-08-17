import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("derived runtime records its exact Apache-2.0 origin", () => {
  const upstream = fs.readFileSync(projectFile("docs/UPSTREAM.md"), "utf8");
  const notice = fs.readFileSync(projectFile("NOTICE"), "utf8");
  const pluginNotice = fs.readFileSync(projectFile("plugins/fleet/NOTICE"), "utf8");

  assert.match(upstream, /db52e28f4d9ded852ab3942cea316258ae4ef346/);
  assert.match(upstream, /plugins\/fleet\/scripts\/lib\/upstream/);
  assert.match(notice, /Copyright 2026 OpenAI/);
  assert.match(notice, /modified by the Codex Fleet contributors/i);
  assert.equal(pluginNotice, notice);
});

test("installable plugin carries the same Apache-2.0 license", () => {
  const rootLicense = fs.readFileSync(projectFile("LICENSE"), "utf8");
  const pluginLicense = fs.readFileSync(projectFile("plugins/fleet/LICENSE"), "utf8");

  assert.match(rootLicense, /Apache License\s+Version 2\.0/);
  assert.equal(pluginLicense, rootLicense);
});
