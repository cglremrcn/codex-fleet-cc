import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  previewSupportBundle,
  writeSupportBundle
} from "../plugins/fleet/scripts/lib/support-bundle.mjs";

function secretFixture(outputPath) {
  return {
    outputPath,
    workspaceKey: "0123456789abcdef0123456789abcdef",
    doctor: {
      overall: "attention",
      token: "Bearer top-secret-token",
      apiKey: "raw-key-that-must-never-survive"
    },
    state: {
      lanes: [{ id: "safe-lane", prompt: "secret prompt", cookie: "session_cookie=abc" }]
    },
    events: ["failure at C:\\Users\\Ada\\private\\repo", "owner ada@example.com"],
    generatedAt: "2026-08-17T12:00:00.000Z"
  };
}

test("support preview contains no prompt, token, cookie, or canonical private path", async () => {
  const outputPath = path.join(os.tmpdir(), "fleet-support-preview.json");
  const preview = await previewSupportBundle(secretFixture(outputPath));
  const serialized = JSON.stringify(preview);

  assert.doesNotMatch(serialized, /secret prompt|top-secret-token|session_cookie|Users\\Ada/);
  assert.doesNotMatch(serialized, /raw-key-that-must-never-survive/);
  assert.match(serialized, /REDACTED/);
  assert.equal(preview.writesPerformed, false);
  await assert.rejects(fs.access(outputPath));
});

test("support confirmation is bound to the exact destination without disclosing it", async () => {
  const first = path.join(os.tmpdir(), "fleet-support-first.json");
  const second = path.join(os.tmpdir(), "fleet-support-second.json");
  const firstPreview = await previewSupportBundle(secretFixture(first));
  const secondPreview = await previewSupportBundle(secretFixture(second));

  assert.notEqual(firstPreview.confirmationToken, secondPreview.confirmationToken);
  assert.doesNotMatch(JSON.stringify(firstPreview), /fleet-support-first/u);
});

test("support export requires the exact preview token and writes only the previewed bundle", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-support-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "support.json");
  const preview = await previewSupportBundle(secretFixture(outputPath));

  await assert.rejects(
    writeSupportBundle(preview, "wrong-token"),
    /exact preview confirmation token/i
  );
  await writeSupportBundle(preview, preview.confirmationToken);
  const written = await fs.readFile(outputPath, "utf8");

  assert.deepEqual(JSON.parse(written), preview.bundle);
  assert.doesNotMatch(written, /secret prompt|top-secret-token|session_cookie|Users\\Ada/);
});
