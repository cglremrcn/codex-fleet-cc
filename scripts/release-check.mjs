import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildPluginArchive } from "./package-plugin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const version = argument("--version");
if (!version) throw new Error("release-check requires --version <semver>.");
const packageManifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const pluginManifest = JSON.parse(
  await fs.readFile(path.join(ROOT, "plugins", "fleet", ".claude-plugin", "plugin.json"), "utf8")
);
const marketplace = JSON.parse(
  await fs.readFile(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
);
const versions = [packageManifest.version, pluginManifest.version, marketplace.plugins?.[0]?.version];
if (versions.some((candidate) => candidate !== version)) {
  throw new Error(`Version mismatch: requested ${version}; found ${versions.join(", ")}.`);
}
if (!process.argv.includes("--allow-dirty") && git(["status", "--porcelain"])) {
  throw new Error("Release source tree is dirty.");
}
if (process.argv.includes("--require-tag")) {
  const tag = git(["describe", "--tags", "--exact-match", "HEAD"]);
  if (tag !== `v${version}`) throw new Error(`Release tag must be v${version}; found ${tag}.`);
}
for (const required of ["LICENSE", "NOTICE", ".claude-plugin/plugin.json"]) {
  await fs.access(path.join(ROOT, "plugins", "fleet", ...required.split("/")));
}
const epoch = Number(process.env.SOURCE_DATE_EPOCH || git(["log", "-1", "--format=%ct"]));
const artifact = await buildPluginArchive({ version, sourceDateEpoch: epoch });
const bytes = await fs.readFile(artifact.archivePath);
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
if (digest !== artifact.sha256) throw new Error("Release archive checksum verification failed.");
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  ok: true,
  version,
  sourceDateEpoch: epoch,
  archive: path.relative(ROOT, artifact.archivePath).replaceAll(path.sep, "/"),
  sha256: digest,
  entries: artifact.entries.length
})}\n`);
