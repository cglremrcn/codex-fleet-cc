import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  scanRepository,
  scanText
} from "../scripts/check-secrets.mjs";
import { auditLicenses } from "../scripts/check-licenses.mjs";
import { evaluatePerformance } from "../scripts/check-performance.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

test("secret scanner reports rules and locations without echoing credentials", () => {
  const credential = `sk-proj-${"A".repeat(32)}`;
  const findings = scanText("fixture.txt", `token=${credential}\nordinary text\n`);

  assert.deepEqual(findings, [{ file: "fixture.txt", line: 1, rule: "openai-api-key" }]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(credential, "u"));
});

test("repository scan follows an explicit bounded file list", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-secret-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "safe.txt"), "no credentials here\n", "utf8");
  await fs.writeFile(
    path.join(root, "unsafe.txt"),
    `key=${`ghp_${"B".repeat(36)}`}\n`,
    "utf8"
  );

  const report = await scanRepository(root, { files: ["safe.txt", "unsafe.txt"] });

  assert.equal(report.scannedFiles, 2);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].file, "unsafe.txt");
});

test("license audit accepts this Apache project and rejects a forbidden dependency", async (t) => {
  const current = await auditLicenses(ROOT);
  assert.equal(current.ok, true, JSON.stringify(current.findings));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-license-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "plugins", "fleet"), { recursive: true });
  await fs.writeFile(path.join(root, "LICENSE"), "Apache License\nVersion 2.0\n", "utf8");
  await fs.writeFile(path.join(root, "NOTICE"), "notice\n", "utf8");
  await fs.writeFile(path.join(root, "plugins", "fleet", "LICENSE"), "Apache License\nVersion 2.0\n", "utf8");
  await fs.writeFile(path.join(root, "plugins", "fleet", "NOTICE"), "notice\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    license: "Apache-2.0"
  }), "utf8");
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0", license: "Apache-2.0" },
      "node_modules/forbidden": { version: "1.0.0", license: "GPL-3.0-only" }
    }
  }), "utf8");

  const invalid = await auditLicenses(root);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.findings, [{
    package: "forbidden",
    license: "GPL-3.0-only",
    reason: "license-not-allowed"
  }]);
});

test("performance gate names every violated budget", () => {
  const report = evaluatePerformance({
    startupP95Ms: 251,
    idleCpuAveragePercent: 1.1,
    redrawHz: 4.1,
    retainedHeapMiB: 65,
    stateBytes: 2_097_153,
    orphanCount: 1
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.violations.map((entry) => entry.metric), [
    "startupP95Ms",
    "idleCpuAveragePercent",
    "redrawHz",
    "retainedHeapMiB",
    "stateBytes",
    "orphanCount"
  ]);
});
