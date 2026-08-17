import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveOwnedPath } from "./paths.mjs";

const OWNERSHIP_FILE = "ownership.json";
const SETTINGS_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const WINDOWS_UNSAFE_COMMAND_PATH = /[%!^&|<>\"]/;

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
    platform: plan.platform,
    version: plan.version,
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

function renderLauncher(template, platform, nodeExecutable, consolePath) {
  if (platform === "win32") {
    if (
      WINDOWS_UNSAFE_COMMAND_PATH.test(nodeExecutable)
      || WINDOWS_UNSAFE_COMMAND_PATH.test(consolePath)
    ) {
      throw new Error("Fleet launcher paths contain characters unsafe for Windows batch files.");
    }
    return template
      .replaceAll("__FLEET_NODE__", nodeExecutable)
      .replaceAll("__FLEET_CONSOLE__", consolePath);
  }
  return template
    .replace("'__FLEET_NODE__'", shellQuote(nodeExecutable))
    .replace("'__FLEET_CONSOLE__'", shellQuote(consolePath));
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
  const template = await readLauncherTemplate(platform);
  const launcherContent = renderLauncher(template, platform, nodeExecutable, consolePath);
  const editorCommand = platform === "win32"
    ? `"${launcherPath}"`
    : shellQuote(launcherPath);
  const originalValues = {
    EDITOR: originalSetting(settingsAfter.env, "EDITOR"),
    VISUAL: originalSetting(settingsAfter.env, "VISUAL")
  };
  const originalEditor = originalValues.VISUAL.existed
    ? originalValues.VISUAL.value
    : originalValues.EDITOR.existed
      ? originalValues.EDITOR.value
      : null;
  settingsAfter.env.EDITOR = editorCommand;
  settingsAfter.env.VISUAL = editorCommand;

  const plan = {
    schemaVersion: 1,
    platform,
    version,
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
    changes: [
      { path: "env.EDITOR", before: originalValues.EDITOR, after: editorCommand },
      { path: "env.VISUAL", before: originalValues.VISUAL, after: editorCommand }
    ],
    restartRequired: true,
    keybindingsModified: false
  };
  return Object.freeze({ ...plan, confirmationToken: confirmationToken(plan) });
}

export async function applySetup(plan = {}) {
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
  if (await pathExists(plan.runtimeTargetDir)) {
    throw new Error(`Versioned Fleet runtime already exists: ${plan.runtimeTargetDir}`);
  }

  await fs.mkdir(plan.pluginDataDir, { recursive: true, mode: DIRECTORY_MODE });
  const stagingDir = resolveOwnedPath(
    plan.pluginDataDir,
    "runtime",
    `.staging-${plan.version}-${crypto.randomUUID()}`
  );
  await copyTreeSafe(plan.runtimeSourceDir, stagingDir);
  await fs.rename(stagingDir, plan.runtimeTargetDir);
  await atomicWrite(
    plan.launcherPath,
    plan.launcherContent,
    plan.platform === "win32" ? 0o600 : 0o700
  );

  const backupDir = resolveOwnedPath(plan.pluginDataDir, "backups");
  await fs.mkdir(backupDir, { recursive: true, mode: DIRECTORY_MODE });
  const timestamp = Number.isFinite(plan.now?.()) ? plan.now() : Date.now();
  const backupPath = resolveOwnedPath(
    backupDir,
    `settings-${timestamp}-${crypto.randomUUID()}.bak`
  );
  await atomicWrite(backupPath, current.raw);

  const ownershipPath = resolveOwnedPath(plan.pluginDataDir, OWNERSHIP_FILE);
  const ownership = {
    schemaVersion: 1,
    status: "pending",
    platform: plan.platform,
    version: plan.version,
    settingsPath: plan.settingsPath,
    settingsExisted: plan.settingsExisted,
    originalValues: plan.originalValues,
    originalEditor: plan.originalEditor,
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
  await atomicWriteJson(ownershipPath, ownership);
  await atomicWriteJson(plan.settingsPath, plan.settingsAfter);
  ownership.status = "applied";
  await atomicWriteJson(ownershipPath, ownership);

  return {
    applied: true,
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
  const runtimeTargetDir = resolveOwnedPath(
    pluginDataDir,
    path.relative(pluginDataDir, ownership.runtimeTargetDir)
  );
  if (await pathExists(runtimeTargetDir)) {
    if (await hashTree(runtimeTargetDir) === ownership.runtimeHash) {
      await fs.rm(runtimeTargetDir, { recursive: true, force: false });
    } else {
      retained.push(runtimeTargetDir);
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
