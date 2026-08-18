import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ALLOWED_LICENSES = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Python-2.0",
  "Unicode-3.0"
]);

async function read(root, relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

async function readJson(root, relativePath) {
  return JSON.parse(await read(root, relativePath));
}

function packageName(lockPath) {
  return lockPath.replace(/^node_modules\//u, "").replace(/\/node_modules\//gu, " > ");
}

export async function auditLicenses(root) {
  const findings = [];
  const [manifest, lock, license, notice, pluginLicense, pluginNotice] = await Promise.all([
    readJson(root, "package.json"),
    readJson(root, "package-lock.json"),
    read(root, "LICENSE"),
    read(root, "NOTICE"),
    read(root, "plugins/fleet/LICENSE"),
    read(root, "plugins/fleet/NOTICE")
  ]);

  if (manifest.license !== "Apache-2.0") {
    findings.push({ package: manifest.name ?? "<root>", license: manifest.license ?? null,
      reason: "root-license-must-be-apache-2.0" });
  }
  if (!/Apache License\s+Version 2\.0/iu.test(license)) {
    findings.push({ file: "LICENSE", reason: "apache-license-text-missing" });
  }
  if (pluginLicense !== license) {
    findings.push({ file: "plugins/fleet/LICENSE", reason: "plugin-license-differs" });
  }
  if (pluginNotice !== notice) {
    findings.push({ file: "plugins/fleet/NOTICE", reason: "plugin-notice-differs" });
  }

  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!lockPath || !lockPath.startsWith("node_modules/")) continue;
    const dependencyLicense = metadata.license ?? null;
    if (!ALLOWED_LICENSES.has(dependencyLicense)) {
      findings.push({
        package: packageName(lockPath),
        license: dependencyLicense,
        reason: "license-not-allowed"
      });
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    ok: findings.length === 0,
    auditedPackages: Object.keys(lock.packages ?? {}).filter((entry) => entry).length,
    findings
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const report = await auditLicenses(process.cwd());
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`License audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
