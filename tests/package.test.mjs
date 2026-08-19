import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPluginArchive } from "../scripts/package-plugin.mjs";

test("release archive is deterministic and contains only the installable plugin", async (t) => {
  const firstOutput = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-package-a-"));
  const secondOutput = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-package-b-"));
  t.after(() => Promise.all([
    fs.rm(firstOutput, { recursive: true, force: true }),
    fs.rm(secondOutput, { recursive: true, force: true })
  ]));

  const options = { version: "0.1.0", sourceDateEpoch: 1_786_914_000 };
  const first = await buildPluginArchive({ ...options, outputDir: firstOutput });
  const second = await buildPluginArchive({ ...options, outputDir: secondOutput });

  assert.equal(first.unexpectedFiles.length, 0);
  assert.equal(first.entries.includes("LICENSE"), true);
  assert.equal(first.entries.includes("NOTICE"), true);
  assert.equal(first.entries.includes(".claude-plugin/plugin.json"), true);
  assert.equal(first.entries.includes("scripts/lib/is-main.mjs"), true);
  assert.equal(first.containsSecretPattern, false);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(
    await fs.readFile(first.archivePath),
    await fs.readFile(second.archivePath)
  );
  assert.match(await fs.readFile(first.checksumPath, "utf8"), new RegExp(first.sha256));
  assert.equal(JSON.parse(await fs.readFile(first.provenancePath, "utf8")).version, "0.1.0");
});
