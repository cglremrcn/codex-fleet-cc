import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getFleetDataDir, resolveOwnedPath } from "./paths.mjs";
import { runOperationalCli } from "./operational-cli.mjs";

const MAX_OWNERSHIP_BYTES = 64 * 1024;
const LOCAL_SCRIPTS_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCAL_PLUGIN_MANIFEST = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const LOCAL_ONLY_COMMANDS = new Set(["setup", "uninstall", "doctor", "help", "--help", "-h"]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
let localVersionPromise = null;

function ownedRoot(env, platform, home) {
  if (env.CLAUDE_PLUGIN_DATA) return path.resolve(env.CLAUDE_PLUGIN_DATA);
  return resolveOwnedPath(getFleetDataDir(env, platform, home), "integration");
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function readLocalVersion() {
  if (!localVersionPromise) {
    localVersionPromise = fs.readFile(LOCAL_PLUGIN_MANIFEST, "utf8").then((source) => {
      const value = JSON.parse(source);
      if (typeof value?.version !== "string" || !VERSION_PATTERN.test(value.version)) {
        throw new Error("Installed Fleet plugin version metadata is invalid.");
      }
      return value.version;
    });
  }
  return localVersionPromise;
}

async function readAppliedRuntime(root) {
  const ownershipPath = path.join(root, "ownership.json");
  try {
    const metadata = await fs.lstat(ownershipPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_OWNERSHIP_BYTES) return null;
    const value = JSON.parse(await fs.readFile(ownershipPath, "utf8"));
    if (
      value?.schemaVersion !== 1
      || value?.status !== "applied"
      || typeof value.version !== "string"
      || !VERSION_PATTERN.test(value.version)
      || typeof value.runtimeTargetDir !== "string"
      || !path.isAbsolute(value.runtimeTargetDir)
    ) {
      return null;
    }
    const runtime = path.resolve(value.runtimeTargetDir);
    const expectedParent = path.join(path.resolve(root), "runtime");
    if (!inside(expectedParent, runtime) || path.basename(runtime) !== value.version) return null;
    const metadataRuntime = await fs.lstat(runtime);
    if (!metadataRuntime.isDirectory() || metadataRuntime.isSymbolicLink()) return null;
    return Object.freeze({ version: value.version, runtimeTargetDir: runtime });
  } catch {
    return null;
  }
}

async function moduleRunner(modulePath, importer) {
  const module = await importer(pathToFileURL(modulePath).href);
  if (typeof module.runOperationalCli === "function") return module.runOperationalCli;
  if (typeof module.runCli === "function") return module.runCli;
  throw new Error("Fleet runtime CLI module does not expose a supported runner.");
}

function requiresInstalledPluginSurface(argv) {
  const command = argv[0] ?? null;
  return LOCAL_ONLY_COMMANDS.has(command) || argv.includes("--help") || argv.includes("-h");
}

function localResult() {
  return Object.freeze({
    source: "installed-plugin",
    scriptsRoot: LOCAL_SCRIPTS_ROOT,
    runner: runOperationalCli
  });
}

export async function resolveFleetCli(argv, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const importer = options.importer ?? ((specifier) => import(specifier));
  if (requiresInstalledPluginSurface(argv)) return localResult();

  const root = ownedRoot(env, platform, home);
  const applied = await (options.readAppliedRuntime ?? readAppliedRuntime)(root);
  if (!applied || path.resolve(applied.runtimeTargetDir) === LOCAL_SCRIPTS_ROOT) return localResult();

  const localVersion = options.localVersion ?? await (options.readLocalVersion ?? readLocalVersion)();
  if (applied.version === localVersion) {
    // Same-version source should use the current installed plugin copy. This preserves new wrapper
    // behavior during development and avoids routing tests/control calls through a stale copied tree.
    return localResult();
  }

  const operationalPath = path.join(applied.runtimeTargetDir, "lib", "operational-cli.mjs");
  const legacyPath = path.join(applied.runtimeTargetDir, "lib", "cli.mjs");
  const target = await fs.access(operationalPath).then(() => operationalPath).catch(async () => {
    await fs.access(legacyPath);
    return legacyPath;
  });
  return Object.freeze({
    source: "owned-integration-runtime",
    version: applied.version,
    scriptsRoot: applied.runtimeTargetDir,
    runner: await moduleRunner(target, importer)
  });
}

export async function runFleetEntrypoint(argv, options = {}) {
  const resolved = await resolveFleetCli(argv, options);
  return resolved.runner(argv, options);
}
