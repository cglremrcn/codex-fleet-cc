import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveOwnedPath } from "./paths.mjs";

const OWNERSHIP_FILE = "ownership.json";
const SETTINGS_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const WINDOWS_UNSAFE_COMMAND_PATH = /[%!^&|<>\"]/;
const WINDOWS_UNSAFE_EDITOR_JSON = /[%!^&|<>\r\n]/;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashValue(value) {
  return hashBytes(JSON.stringify(value));
}

function compareSemanticVersions(left, right) {
  const parse = (value) => {
    const [withoutBuild] = String(value).split("+");
    const [core, prerelease = null] = withoutBuild.split("-", 2);
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10)),
      prerelease: prerelease?.split(".") ?? null
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] < rightVersion.core[index] ? -1 : 1;
    }
  }
  if (leftVersion.prerelease === null || rightVersion.prerelease === null) {
    if (leftVersion.prerelease === rightVersion.prerelease) return 0;
    return leftVersion.prerelease === null ? 1 : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableObject(value[key])])
    );
  }
  return value;
}

function confirmationPayload(plan) {
  return stableObject({
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    platform: plan.platform,
    version: plan.version,
    previousVersion: plan.previousVersion,
    settingsPath: plan.settingsPath,
    pluginDataDir: plan.pluginDataDir,
    runtimeSourceDir: plan.runtimeSourceDir,
    runtimeTargetDir: plan.runtimeTargetDir,
    launcherPath: plan.launcherPath,
    launcherContent: plan.launcherContent,
    editorCommand: plan.editorCommand,
    settingsSourceHash: plan.settingsSourceHash,
    settingsExisted: plan.settingsExisted,
    settingsAfter: plan.settingsAfter,
    originalValues: plan.originalValues,
    originalEditor: plan.originalEditor,
    originalEditorCommand: plan.originalEditorCommand,
    ownershipSourceHash: plan.ownershipSourceHash,
    previousRuntimeTargetDir: plan.previousRuntimeTargetDir,
    previousRuntimeHash: plan.previousRuntimeHash,
    previousLauncherHash: plan.previousLauncherHash,
    changes: plan.changes,
    restartRequired: plan.restartRequired,
    keybindingsModified: plan.keybindingsModified
  });
}

function confirmationToken(plan) {
  return hashBytes(JSON.stringify(confirmationPayload(plan)));
}

async function readSettingsSource(settingsPath) {
  try {
    const metadata = await fs.lstat(settingsPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Claude settings must be a regular, non-symbolic-link file.");
    }
    const raw = await fs.readFile(settingsPath);
    let settings;
    try {
      settings = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new Error(`Claude settings contain invalid JSON: ${error.message}`);
    }
    assertPlainObject(settings, "Claude settings");
    return { existed: true, raw, settings, hash: hashBytes(raw) };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return {
      existed: false,
      raw: Buffer.alloc(0),
      settings: {},
      hash: hashBytes(Buffer.alloc(0))
    };
  }
}

function clone(value) {
  return structuredClone(value);
}

function originalSetting(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key)
    ? { existed: true, value: env[key] }
    : { existed: false, value: null };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function parseEditorCommand(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const source = String(value);
  if (source.length > 4096 || /[\u0000\r\n]/.test(source)) {
    throw new Error("Original editor command is invalid or too long.");
  }
  const command = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === null && /\s/.test(character)) {
      if (started) {
        command.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === null) {
        quote = character;
        started = true;
        continue;
      }
      if (quote === character) {
        quote = null;
        continue;
      }
    }
    if (character === "\\" && quote !== "'" && index + 1 < source.length) {
      const next = source[index + 1];
      if (next === quote || next === "\\" || (quote === null && /[\s'\"]/.test(next))) {
        current += next;
        started = true;
        index += 1;
        continue;
      }
    }
    current += character;
    started = true;
  }
  if (quote !== null) throw new Error("Original editor command contains an unmatched quote.");
  if (started) command.push(current);
  if (command.length === 0 || command.length > 32) {
    throw new Error("Original editor command must contain between 1 and 32 arguments.");
  }
  return command;
}

function renderLauncher(
  template,
  platform,
  nodeExecutable,
  consolePath,
  originalEditorCommand,
  version
) {
  const originalEditorJson = JSON.stringify(originalEditorCommand);
  if (platform === "win32") {
    if (
      WINDOWS_UNSAFE_COMMAND_PATH.test(nodeExecutable)
      || WINDOWS_UNSAFE_COMMAND_PATH.test(consolePath)
    ) {
      throw new Error("Fleet launcher paths contain characters unsafe for Windows batch files.");
    }
    if (WINDOWS_UNSAFE_EDITOR_JSON.test(originalEditorJson)) {
      throw new Error("Original editor command contains characters unsafe for Windows batch files.");
    }
    return template
      .replaceAll("__FLEET_NODE__", nodeExecutable)
      .replaceAll("__FLEET_CONSOLE__", consolePath)
      .replaceAll("__FLEET_ORIGINAL_EDITOR_JSON__", originalEditorJson)
      .replaceAll("__FLEET_INTEGRATION_VERSION__", version);
  }
  return template
    .replace("'__FLEET_NODE__'", shellQuote(nodeExecutable))
    .replace("'__FLEET_CONSOLE__'", shellQuote(consolePath))
    .replace("'__FLEET_ORIGINAL_EDITOR_JSON__'", shellQuote(originalEditorJson))
    .replace("'__FLEET_INTEGRATION_VERSION__'", shellQuote(version));
}

async function readLauncherTemplate(platform) {
  const name = platform === "win32" ? "fleet-editor.cmd" : "fleet-editor.sh";
  return fs.readFile(new URL(`../launchers/${name}`, import.meta.url), "utf8");
}

async function atomicWrite(filePath, contents, mode = SETTINGS_MODE) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, mode).catch((error) => {
      if (process.platform !== "win32") {
        throw error;
      }
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyTreeSafe(source, destination) {
  const metadata = await fs.lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Runtime source cannot contain symbolic links: ${source}`);
  }
  if (metadata.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: DIRECTORY_MODE });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await copyTreeSafe(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`Runtime source contains an unsupported file type: ${source}`);
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, metadata.mode & 0o777).catch((error) => {
    if (process.platform !== "win32") {
      throw error;
    }
  });
}

async function hashTree(root) {
  const records = [];
  async function visit(current, relative) {
    const metadata = await fs.lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Owned runtime cannot contain symbolic links: ${current}`);
    }
    if (metadata.isDirectory()) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        await visit(path.join(current, entry.name), childRelative);
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(`Owned runtime contains an unsupported file type: ${current}`);
    }
    records.push(`${relative}\0${hashBytes(await fs.readFile(current))}`);
  }
  await visit(root, "");
  return hashBytes(records.join("\n"));
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readOwnershipSource(ownershipPath) {
  const metadata = await fs.lstat(ownershipPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Fleet ownership manifest must be a regular, non-symbolic-link file.");
  }
  const raw = await fs.readFile(ownershipPath);
  let ownership;
  try {
    ownership = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Fleet ownership manifest contains invalid JSON: ${error.message}`);
  }
  assertPlainObject(ownership, "Fleet ownership manifest");
  if (ownership.schemaVersion !== 1 || ownership.status !== "applied") {
    throw new Error("Fleet setup ownership manifest is incomplete or unsupported.");
  }
  return { ownership, raw, hash: hashBytes(raw) };
}

function requireOwnedPath(pluginDataDir, value, label) {
  const absolute = requireAbsolute(value, label);
  const resolved = resolveOwnedPath(pluginDataDir, path.relative(pluginDataDir, absolute));
  if (resolved !== absolute) {
    throw new Error(`${label} is outside the Fleet-owned integration root.`);
  }
  return resolved;
}

async function verifyOwnedInstallation(options) {
  const { ownership, pluginDataDir, settingsPath, launcherPath, platform, settings } = options;
  if (ownership.platform !== platform || path.resolve(ownership.settingsPath) !== settingsPath) {
    throw new Error("Fleet ownership does not match this platform or Claude settings file.");
  }
  const ownedLauncher = requireOwnedPath(pluginDataDir, ownership.launcherPath, "Owned launcher");
  if (ownedLauncher !== launcherPath) {
    throw new Error("Fleet ownership launcher path does not match the integration launcher.");
  }
  const ownedRuntime = requireOwnedPath(
    pluginDataDir,
    ownership.runtimeTargetDir,
    "Owned runtime"
  );
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env
    : {};
  for (const key of ["EDITOR", "VISUAL"]) {
    if (hashValue(env[key]) !== ownership.writtenHashes?.[key]) {
      throw new Error(`Claude env.${key} is no longer owned by Fleet; setup upgrade was refused.`);
    }
  }
  const launcherMetadata = await fs.lstat(ownedLauncher);
  if (launcherMetadata.isSymbolicLink() || !launcherMetadata.isFile()) {
    throw new Error("Fleet-owned launcher is no longer a regular file.");
  }
  if (hashBytes(await fs.readFile(ownedLauncher)) !== ownership.launcherHash) {
    throw new Error("Fleet launcher is no longer owned; setup upgrade was refused.");
  }
  const runtimeMetadata = await fs.lstat(ownedRuntime);
  if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) {
    throw new Error("Fleet-owned runtime is no longer a regular directory.");
  }
  if (await hashTree(ownedRuntime) !== ownership.runtimeHash) {
    throw new Error("Fleet runtime is no longer owned; setup upgrade was refused.");
  }
  return { launcherPath: ownedLauncher, runtimeTargetDir: ownedRuntime };
}

export async function previewSetup(options = {}) {
  const settingsPath = requireAbsolute(options.settingsPath, "settingsPath");
  const pluginDataDir = requireAbsolute(options.pluginDataDir, "pluginDataDir");
  const runtimeSourceDir = requireAbsolute(options.runtimeSourceDir, "runtimeSourceDir");
  const nodeExecutable = requireAbsolute(options.nodeExecutable, "nodeExecutable");
  const platform = options.platform ?? process.platform;
  if (!["win32", "darwin", "linux"].includes(platform)) {
    throw new Error(`Unsupported setup platform: ${platform}.`);
  }
  const version = String(options.version ?? "0.0.0");
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new TypeError("Setup version must be a semantic version string.");
  }
  const source = await readSettingsSource(settingsPath);
  const settingsAfter = clone(source.settings);
  settingsAfter.env = settingsAfter.env && typeof settingsAfter.env === "object"
    && !Array.isArray(settingsAfter.env)
    ? { ...settingsAfter.env }
    : {};

  const runtimeTargetDir = resolveOwnedPath(pluginDataDir, "runtime", version);
  const consolePath = resolveOwnedPath(runtimeTargetDir, "fleet-console.mjs");
  const launcherName = platform === "win32" ? "fleet-editor.cmd" : "fleet-editor.sh";
  const launcherPath = resolveOwnedPath(pluginDataDir, "bin", launcherName);
  const ownershipPath = resolveOwnedPath(pluginDataDir, OWNERSHIP_FILE);
  let prior = null;
  if (await pathExists(ownershipPath)) {
    prior = await readOwnershipSource(ownershipPath);
    await verifyOwnedInstallation({
      ownership: prior.ownership,
      pluginDataDir,
      settingsPath,
      launcherPath,
      platform,
      settings: source.settings
    });
    if (compareSemanticVersions(version, prior.ownership.version) < 0) {
      throw new Error(
        `Fleet setup downgrade from ${prior.ownership.version} to ${version} was refused.`
      );
    }
  }
  const mode = prior ? prior.ownership.version === version ? "current" : "upgrade" : "fresh";
  const template = await readLauncherTemplate(platform);
  const editorCommand = platform === "win32"
    ? `"${launcherPath}"`
    : shellQuote(launcherPath);
  const originalValues = prior?.ownership.originalValues ?? {
    EDITOR: originalSetting(settingsAfter.env, "EDITOR"),
    VISUAL: originalSetting(settingsAfter.env, "VISUAL")
  };
  const originalEditor = prior
    ? prior.ownership.originalEditor
    : originalValues.VISUAL.existed
      ? originalValues.VISUAL.value
      : originalValues.EDITOR.existed
        ? originalValues.EDITOR.value
        : null;
  const originalEditorCommand = prior
    ? prior.ownership.originalEditorCommand
    : parseEditorCommand(originalEditor);
  const launcherContent = renderLauncher(
    template,
    platform,
    nodeExecutable,
    consolePath,
    originalEditorCommand,
    version
  );
  settingsAfter.env.EDITOR = editorCommand;
  settingsAfter.env.VISUAL = editorCommand;

  const plan = {
    schemaVersion: 1,
    mode,
    platform,
    version,
    previousVersion: prior?.ownership.version ?? null,
    settingsPath,
    pluginDataDir,
    runtimeSourceDir,
    runtimeTargetDir,
    launcherPath,
    launcherContent,
    editorCommand,
    settingsSourceHash: source.hash,
    settingsExisted: source.existed,
    settingsAfter,
    originalValues,
    originalEditor,
    originalEditorCommand,
    ownershipSourceHash: prior?.hash ?? null,
    previousRuntimeTargetDir: prior?.ownership.runtimeTargetDir ?? null,
    previousRuntimeHash: prior?.ownership.runtimeHash ?? null,
    previousLauncherHash: prior?.ownership.launcherHash ?? null,
    changes: mode === "fresh" ? [
      { path: "env.EDITOR", before: originalValues.EDITOR, after: editorCommand },
      { path: "env.VISUAL", before: originalValues.VISUAL, after: editorCommand }
    ] : mode === "upgrade" ? [{
      path: "integration.runtime",
      before: prior.ownership.version,
      after: version
    }] : [],
    restartRequired: true,
    keybindingsModified: false
  };
  return Object.freeze({ ...plan, confirmationToken: confirmationToken(plan) });
}

export async function applySetup(plan = {}, dependencies = {}) {
  assertPlainObject(plan, "Setup plan");
  if (!plan.confirmation || plan.confirmation !== plan.confirmationToken) {
    throw new Error("Setup requires the exact preview confirmation token.");
  }
  if (confirmationToken(plan) !== plan.confirmationToken) {
    throw new Error("Setup confirmation token does not match the current plan.");
  }
  const current = await readSettingsSource(plan.settingsPath);
  if (current.hash !== plan.settingsSourceHash || current.existed !== plan.settingsExisted) {
    throw new Error("Claude settings changed since preview; generate a new setup preview.");
  }
  const ownershipPath = resolveOwnedPath(plan.pluginDataDir, OWNERSHIP_FILE);
  if (plan.mode === "current") {
    const prior = await readOwnershipSource(ownershipPath);
    if (prior.hash !== plan.ownershipSourceHash) {
      throw new Error("Fleet ownership changed since preview; generate a new setup preview.");
    }
    await verifyOwnedInstallation({
      ownership: prior.ownership,
      pluginDataDir: plan.pluginDataDir,
      settingsPath: plan.settingsPath,
      launcherPath: plan.launcherPath,
      platform: plan.platform,
      settings: current.settings
    });
    return {
      applied: false,
      mode: "current",
      launcherPath: plan.launcherPath,
      runtimeTargetDir: plan.runtimeTargetDir,
      restartRequired: false
    };
  }
  if (await pathExists(plan.runtimeTargetDir)) {
    throw new Error(`Versioned Fleet runtime already exists: ${plan.runtimeTargetDir}`);
  }
  if (plan.mode === "upgrade") {
    const prior = await readOwnershipSource(ownershipPath);
    if (prior.hash !== plan.ownershipSourceHash) {
      throw new Error("Fleet ownership changed since preview; generate a new setup preview.");
    }
    await verifyOwnedInstallation({
      ownership: prior.ownership,
      pluginDataDir: plan.pluginDataDir,
      settingsPath: plan.settingsPath,
      launcherPath: plan.launcherPath,
      platform: plan.platform,
      settings: current.settings
    });
    const stagingDir = resolveOwnedPath(
      plan.pluginDataDir,
      "runtime",
      `.staging-${plan.version}-${crypto.randomUUID()}`
    );
    const previousLauncher = await fs.readFile(plan.launcherPath);
    const writeFile = dependencies.atomicWrite ?? atomicWrite;
    const writeJson = dependencies.atomicWriteJson ?? atomicWriteJson;
    const previousLauncherHash = hashBytes(previousLauncher);
    const nextLauncherHash = hashBytes(Buffer.from(plan.launcherContent, "utf8"));
    let nextOwnershipHash = null;
    try {
      await copyTreeSafe(plan.runtimeSourceDir, stagingDir);
      await fs.rename(stagingDir, plan.runtimeTargetDir);
      await writeFile(
        plan.launcherPath,
        plan.launcherContent,
        plan.platform === "win32" ? 0o600 : 0o700
      );
      const latestSettings = await readSettingsSource(plan.settingsPath);
      const latestOwnership = await readOwnershipSource(ownershipPath);
      if (
        latestSettings.hash !== current.hash
        || latestSettings.existed !== current.existed
        || latestOwnership.hash !== prior.hash
      ) {
        throw new Error("Fleet ownership or Claude settings changed while upgrade was prepared.");
      }
      const supersededRuntimes = [
        ...(Array.isArray(prior.ownership.supersededRuntimes)
          ? prior.ownership.supersededRuntimes
          : []),
        {
          path: prior.ownership.runtimeTargetDir,
          hash: prior.ownership.runtimeHash
        }
      ];
      const ownership = {
        ...prior.ownership,
        status: "applied",
        version: plan.version,
        runtimeTargetDir: plan.runtimeTargetDir,
        runtimeHash: await hashTree(plan.runtimeTargetDir),
        launcherHash: hashBytes(Buffer.from(plan.launcherContent, "utf8")),
        supersededRuntimes,
        restartRequired: true,
        upgradedAt: new Date(Number.isFinite(plan.now?.()) ? plan.now() : Date.now()).toISOString()
      };
      nextOwnershipHash = hashBytes(Buffer.from(`${JSON.stringify(ownership, null, 2)}\n`, "utf8"));
      await writeJson(ownershipPath, ownership);
    } catch (error) {
      const rollbackProblems = [];
      let launcherRestored = false;
      let ownershipRestored = false;
      try {
        const currentLauncherHash = hashBytes(await fs.readFile(plan.launcherPath));
        if (currentLauncherHash === previousLauncherHash) {
          launcherRestored = true;
        } else if (currentLauncherHash === nextLauncherHash) {
          await writeFile(
            plan.launcherPath,
            previousLauncher,
            plan.platform === "win32" ? 0o600 : 0o700
          );
          launcherRestored = hashBytes(await fs.readFile(plan.launcherPath)) === previousLauncherHash;
          if (!launcherRestored) rollbackProblems.push("launcher restore verification failed");
        } else {
          rollbackProblems.push("launcher changed concurrently");
        }
      } catch (rollbackError) {
        rollbackProblems.push(`launcher restore failed: ${rollbackError.message}`);
      }
      try {
        const currentOwnershipHash = hashBytes(await fs.readFile(ownershipPath));
        if (currentOwnershipHash === prior.hash) {
          ownershipRestored = true;
        } else if (nextOwnershipHash && currentOwnershipHash === nextOwnershipHash) {
          await atomicWrite(ownershipPath, prior.raw);
          ownershipRestored = hashBytes(await fs.readFile(ownershipPath)) === prior.hash;
          if (!ownershipRestored) rollbackProblems.push("ownership restore verification failed");
        } else {
          rollbackProblems.push("ownership changed concurrently");
        }
      } catch (rollbackError) {
        rollbackProblems.push(`ownership restore failed: ${rollbackError.message}`);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch((rollbackError) => {
        rollbackProblems.push(`staging cleanup failed: ${rollbackError.message}`);
      });
      if (launcherRestored && ownershipRestored) {
        await fs.rm(plan.runtimeTargetDir, { recursive: true, force: true }).catch(
          (rollbackError) => rollbackProblems.push(
            `new runtime cleanup failed: ${rollbackError.message}`
          )
        );
      }
      if (rollbackProblems.length > 0) {
        throw new Error(
          `Fleet setup upgrade failed. Rollback incomplete: ${rollbackProblems.join("; ")}. `
          + "Recovery artifacts were retained.",
          { cause: error }
        );
      }
      throw error;
    }
    return {
      applied: true,
      mode: "upgrade",
      launcherPath: plan.launcherPath,
      runtimeTargetDir: plan.runtimeTargetDir,
      restartRequired: true
    };
  }
  if (await pathExists(plan.launcherPath) || await pathExists(ownershipPath)) {
    throw new Error("Fleet setup already owns a launcher or manifest; uninstall it first.");
  }

  const writeJson = dependencies.atomicWriteJson ?? atomicWriteJson;
  const beforeSettingsCommit = dependencies.beforeSettingsCommit ?? (() => undefined);
  await fs.mkdir(plan.pluginDataDir, { recursive: true, mode: DIRECTORY_MODE });
  const stagingDir = resolveOwnedPath(
    plan.pluginDataDir,
    "runtime",
    `.staging-${plan.version}-${crypto.randomUUID()}`
  );
  const backupDir = resolveOwnedPath(plan.pluginDataDir, "backups");
  const timestamp = Number.isFinite(plan.now?.()) ? plan.now() : Date.now();
  const backupPath = resolveOwnedPath(
    backupDir,
    `settings-${timestamp}-${crypto.randomUUID()}.bak`
  );
  const expectedSettings = Buffer.from(`${JSON.stringify(plan.settingsAfter, null, 2)}\n`);
  let settingsWriteAttempted = false;
  try {
    await copyTreeSafe(plan.runtimeSourceDir, stagingDir);
    await fs.rename(stagingDir, plan.runtimeTargetDir);
    await atomicWrite(
      plan.launcherPath,
      plan.launcherContent,
      plan.platform === "win32" ? 0o600 : 0o700
    );
    await fs.mkdir(backupDir, { recursive: true, mode: DIRECTORY_MODE });
    await atomicWrite(backupPath, current.raw);

    const ownership = {
      schemaVersion: 1,
      status: "pending",
      platform: plan.platform,
      version: plan.version,
      settingsPath: plan.settingsPath,
      settingsExisted: plan.settingsExisted,
      originalValues: plan.originalValues,
      originalEditor: plan.originalEditor,
      originalEditorCommand: plan.originalEditorCommand,
      writtenValues: { EDITOR: plan.editorCommand, VISUAL: plan.editorCommand },
      writtenHashes: {
        EDITOR: hashValue(plan.editorCommand),
        VISUAL: hashValue(plan.editorCommand)
      },
      runtimeTargetDir: plan.runtimeTargetDir,
      runtimeHash: await hashTree(plan.runtimeTargetDir),
      launcherPath: plan.launcherPath,
      launcherHash: hashBytes(Buffer.from(plan.launcherContent, "utf8")),
      backupPath,
      restartRequired: true,
      keybindingsModified: false,
      appliedAt: new Date(timestamp).toISOString()
    };
    await writeJson(ownershipPath, ownership);
    await beforeSettingsCommit();
    const latest = await readSettingsSource(plan.settingsPath);
    if (latest.hash !== current.hash || latest.existed !== current.existed) {
      throw new Error("Claude settings changed while setup was being prepared; try again.");
    }
    settingsWriteAttempted = true;
    await writeJson(plan.settingsPath, plan.settingsAfter);
    ownership.status = "applied";
    await writeJson(ownershipPath, ownership);
  } catch (error) {
    let safeToRemoveOwnedFiles = !settingsWriteAttempted;
    if (settingsWriteAttempted) {
      const latest = await readSettingsSource(plan.settingsPath).catch(() => null);
      if (latest?.hash === hashBytes(expectedSettings)) {
        if (plan.settingsExisted) {
          await atomicWrite(plan.settingsPath, current.raw);
        } else {
          await fs.unlink(plan.settingsPath).catch((unlinkError) => {
            if (unlinkError.code !== "ENOENT") throw unlinkError;
          });
        }
        safeToRemoveOwnedFiles = true;
      } else if (latest?.hash === current.hash && latest.existed === current.existed) {
        safeToRemoveOwnedFiles = true;
      }
    }
    if (safeToRemoveOwnedFiles) {
      await fs.unlink(ownershipPath).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      await fs.unlink(plan.launcherPath).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      await fs.rm(plan.runtimeTargetDir, { recursive: true, force: true });
      await fs.unlink(backupPath).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
    await fs.rm(stagingDir, { recursive: true, force: true });
    if (!safeToRemoveOwnedFiles) {
      throw new Error(
        "Fleet setup failed after Claude settings changed externally; owned recovery files were retained.",
        { cause: error }
      );
    }
    throw error;
  }

  return {
    applied: true,
    mode: "fresh",
    launcherPath: plan.launcherPath,
    runtimeTargetDir: plan.runtimeTargetDir,
    restartRequired: true
  };
}

function restoreOwnedValue(env, key, original) {
  if (original.existed) {
    env[key] = original.value;
  } else {
    delete env[key];
  }
}

export async function uninstallSetup(options = {}) {
  const pluginDataDir = requireAbsolute(options.pluginDataDir, "pluginDataDir");
  const preview = await previewUninstallSetup({ pluginDataDir });
  if (options.confirmationToken !== preview.confirmationToken) {
    throw new Error("Uninstall requires the exact preview confirmation token.");
  }
  const ownershipPath = resolveOwnedPath(pluginDataDir, OWNERSHIP_FILE);
  let ownership;
  try {
    ownership = JSON.parse(await fs.readFile(ownershipPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Fleet setup ownership manifest was not found.");
    }
    throw error;
  }
  assertPlainObject(ownership, "Fleet ownership manifest");
  if (ownership.schemaVersion !== 1 || ownership.status !== "applied") {
    throw new Error("Fleet setup ownership manifest is incomplete or unsupported.");
  }

  const current = await readSettingsSource(ownership.settingsPath);
  const settings = clone(current.settings);
  settings.env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? { ...settings.env }
    : {};
  for (const key of ["EDITOR", "VISUAL"]) {
    if (hashValue(settings.env[key]) !== ownership.writtenHashes[key]) {
      throw new Error(
        `Claude env.${key} is no longer owned by Fleet; uninstall will not overwrite it.`
      );
    }
  }
  restoreOwnedValue(settings.env, "EDITOR", ownership.originalValues.EDITOR);
  restoreOwnedValue(settings.env, "VISUAL", ownership.originalValues.VISUAL);
  await atomicWriteJson(ownership.settingsPath, settings);

  const retained = [];
  const launcherPath = resolveOwnedPath(
    pluginDataDir,
    path.relative(pluginDataDir, ownership.launcherPath)
  );
  if (await pathExists(launcherPath)) {
    const currentLauncherHash = hashBytes(await fs.readFile(launcherPath));
    if (currentLauncherHash === ownership.launcherHash) {
      await fs.unlink(launcherPath);
    } else {
      retained.push(launcherPath);
    }
  }
  const runtimeRecords = [
    { path: ownership.runtimeTargetDir, hash: ownership.runtimeHash },
    ...(Array.isArray(ownership.supersededRuntimes) ? ownership.supersededRuntimes : [])
  ];
  const visitedRuntimePaths = new Set();
  for (const record of runtimeRecords) {
    assertPlainObject(record, "Fleet-owned runtime record");
    const runtimeTargetDir = requireOwnedPath(
      pluginDataDir,
      record.path,
      "Owned runtime"
    );
    if (visitedRuntimePaths.has(runtimeTargetDir)) continue;
    visitedRuntimePaths.add(runtimeTargetDir);
    if (await pathExists(runtimeTargetDir)) {
      if (await hashTree(runtimeTargetDir) === record.hash) {
        await fs.rm(runtimeTargetDir, { recursive: true, force: false });
      } else {
        retained.push(runtimeTargetDir);
      }
    }
  }
  await fs.unlink(ownership.backupPath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await fs.unlink(ownershipPath);

  return { restored: true, retained, restartRequired: true };
}

export async function previewUninstallSetup(options = {}) {
  const pluginDataDir = requireAbsolute(options.pluginDataDir, "pluginDataDir");
  const ownershipPath = resolveOwnedPath(pluginDataDir, OWNERSHIP_FILE);
  let ownership;
  try {
    ownership = JSON.parse(await fs.readFile(ownershipPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Fleet setup ownership manifest was not found.");
    }
    throw error;
  }
  assertPlainObject(ownership, "Fleet ownership manifest");
  if (ownership.schemaVersion !== 1 || ownership.status !== "applied") {
    throw new Error("Fleet setup ownership manifest is incomplete or unsupported.");
  }
  const current = await readSettingsSource(ownership.settingsPath);
  const settings = current.settings;
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env
    : {};
  for (const key of ["EDITOR", "VISUAL"]) {
    if (hashValue(env[key]) !== ownership.writtenHashes[key]) {
      throw new Error(`Claude env.${key} is no longer owned by Fleet; uninstall will not overwrite it.`);
    }
  }
  const runtimePaths = [
    ownership.runtimeTargetDir,
    ...(Array.isArray(ownership.supersededRuntimes)
      ? ownership.supersededRuntimes.map((record) => record?.path)
      : [])
  ].filter((value, index, values) => typeof value === "string" && values.indexOf(value) === index);
  for (const runtimePath of runtimePaths) {
    requireOwnedPath(pluginDataDir, runtimePath, "Owned runtime");
  }
  const payload = stableObject({
    schemaVersion: 1,
    pluginDataDir,
    ownershipPath,
    settingsPath: ownership.settingsPath,
    settingsSourceHash: current.hash,
    restore: ownership.originalValues,
    remove: [ownership.launcherPath, ...runtimePaths],
    restartRequired: true
  });
  return Object.freeze({
    ...payload,
    writesPerformed: false,
    confirmationToken: hashBytes(JSON.stringify(payload))
  });
}
