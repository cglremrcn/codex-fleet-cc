#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readFleetInventory } from "./lib/fleet-inventory.mjs";
import { resolveRegisteredWorkspace } from "./lib/workspace-registry.mjs";
import { readConsolePreferences, writeConsolePreferences } from "./lib/console-preferences.mjs";
import { runConsole } from "./lib/console-controller.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { getFleetDataDir, resolveOwnedPath, workspaceKey } from "./lib/paths.mjs";
import { readWorkspaceState } from "./lib/safe-state.mjs";
import {
  ensureSupervisor,
  requestSupervisor
} from "./lib/supervisor-protocol.mjs";
import { buildViewModel, renderScreen } from "./lib/tui-render.mjs";

const EXIT_SUCCESS = 0;
const EXIT_INVALID_INPUT = 2;

function emptySnapshot(cwd) {
  return {
    schemaVersion: 1,
    workspace: { name: path.basename(cwd), branch: "branch-not-reported" },
    runtime: { health: "unknown", protocol: "unknown", activeLimit: null },
    lanes: [],
    updatedAt: null
  };
}

async function readBranch(cwd) {
  const gitPath = path.join(cwd, ".git");
  try {
    const gitMetadata = await fs.lstat(gitPath);
    if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
      return "branch-not-reported";
    }
    const headPath = path.join(gitPath, "HEAD");
    const headMetadata = await fs.lstat(headPath);
    if (!headMetadata.isFile() || headMetadata.isSymbolicLink()) {
      return "branch-not-reported";
    }
    const head = (await fs.readFile(headPath, "utf8")).trim();
    const prefix = "ref: refs/heads/";
    return head.startsWith(prefix) ? head.slice(prefix.length) : "detached";
  } catch {
    return "branch-not-reported";
  }
}

export function createFileStateReader(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  let cache = null, cacheScope = null, cacheTime = 0, inFlight = null;
  return async function readState({ scope = "workspace", force = false } = {}) {
    if (scope === "projects" || scope === "native") {
      const ttl = scope === "native" ? 5000 : 1000;
      if (!force && cacheScope === scope && cache && Date.now() - cacheTime < ttl) return cache;
      if (inFlight?.scope === scope) return inFlight.promise;
      const promise = (async () => {
        const result = scope === "projects"
          ? await readFleetInventory(getFleetDataDir(env, platform, home))
          : await options.runtime.nativeInventory();
        const next = { ...emptySnapshot(cwd), ...result,
          workspace: { name: scope === "projects" ? "ALL FLEET PROJECTS" : "ALL CODEX THREADS", branch: "metadata inventory" },
          scope, updatedAt: new Date().toISOString() };
        cache = next; cacheScope = scope; cacheTime = Date.now();
        return next;
      })();
      inFlight = { scope, promise };
      try { return await promise; } finally { if (inFlight?.promise === promise) inFlight = null; }
    }
    const snapshot = emptySnapshot(cwd);
    snapshot.workspace.branch = await readBranch(cwd);
    const key = await workspaceKey(cwd, { platform });
    const dataRoot = getFleetDataDir(env, platform, home);
    const stateRoot = resolveOwnedPath(dataRoot, "workspaces", key);
    try {
      const metadata = await fs.lstat(stateRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return snapshot;
      }
    } catch (error) {
      if (error.code === "ENOENT") return snapshot;
      throw error;
    }
    const stored = await readWorkspaceState(stateRoot);
    return {
      ...snapshot,
      ...stored,
      workspace: snapshot.workspace,
      runtime: snapshot.runtime
    };
  };
}

function parseEditorCommand(env) {
  const source = env.FLEET_ORIGINAL_EDITOR_JSON;
  if (!source) return null;
  let command;
  try {
    command = JSON.parse(source);
  } catch {
    throw new Error("FLEET_ORIGINAL_EDITOR_JSON must be valid JSON");
  }
  if (command === null) return null;
  if (
    !Array.isArray(command)
    || command.length === 0
    || command.length > 32
    || command.some((item) => typeof item !== "string" || /[\u0000\r\n]/.test(item))
  ) {
    throw new Error("FLEET_ORIGINAL_EDITOR_JSON must be a bounded string array");
  }
  return command;
}

export function createOriginalEditor(env = process.env) {
  const command = parseEditorCommand(env);
  if (!command) return undefined;
  return async function openOriginalEditor(draftPath) {
    const [executable, ...args] = command;
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [...args, draftPath], {
        shell: false,
        stdio: "inherit",
        windowsHide: true
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Original editor exited with ${signal ?? code}`));
      });
    });
  };
}

export async function createSupervisorRuntime(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const key = await workspaceKey(cwd, { platform });
  const dataDir = getFleetDataDir(env, platform, home);
  const ensure = options.ensureSupervisor ?? ensureSupervisor;
  const request = options.requestSupervisor ?? requestSupervisor;

  async function call(method, params, lane = null) {
    if (lane?.controlAvailable === false) {
      const error = new Error("Observed sessions are read-only; use their owning Codex client for control.");
      error.code = "AUTHORITY_DENIED";
      throw error;
    }
    const project = lane?.originWorkspaceKey && lane.originWorkspaceKey !== key
      ? await resolveRegisteredWorkspace(dataDir, lane.originWorkspaceKey)
      : { workspaceKey: key, workspacePath: cwd };
    const manifest = await ensure({
      dataDir,
      workspaceKey: project.workspaceKey,
      workspacePath: project.workspacePath,
      scriptPath: fileURLToPath(new URL("./fleet-supervisor.mjs", import.meta.url)),
      nodeExecutable: process.execPath,
      env
    });
    return request({
      address: manifest.address,
      workspaceKey: project.workspaceKey,
      token: manifest.token,
      method,
      params
    });
  }

  return Object.freeze({
    async nativeInventory() {
      const lanes = [], seen = new Set(); let cursor = null, result;
      for (let page = 0; page < 40; page += 1) {
        result = await call("nativeInventory", { cursor, limit: 100 });
        if (!Array.isArray(result?.lanes)) throw new Error("Malformed native inventory.");
        lanes.push(...result.lanes); cursor = result.nextCursor ?? null;
        if (!cursor) return { ...result, lanes };
        if (seen.has(cursor)) throw new Error("Repeated native inventory cursor.");
        seen.add(cursor);
      }
      return { ...result, lanes, truncated: true };
    },
    async session(lane) {
      if (lane.observation === "runtime-metadata") return call("observeSession", { threadId: lane.threadId });
      return call("session", { laneId: lane.controlId ?? lane.id }, lane);
    },
    async message(lane, message) {
      return call("message", { laneId: lane.controlId ?? lane.id, message }, lane);
    },
    async followUp(lane, message) {
      return call("followUp", { laneId: lane.controlId ?? lane.id, message }, lane);
    },
    async cancel(lane, expectedIdentity) {
      if (
        expectedIdentity?.threadId !== (lane.threadId ?? null)
        || expectedIdentity?.turnId !== (lane.turnId ?? null)
      ) {
        const error = new Error("Cancellation target identity changed.");
        error.code = "AUTHORITY_DENIED";
        throw error;
      }
      const preview = await call("cancel", { laneId: lane.controlId ?? lane.id }, lane);
      if (
        preview.expectedThreadId !== expectedIdentity.threadId
        || preview.expectedTurnId !== expectedIdentity.turnId
      ) {
        const error = new Error("Cancellation target identity changed.");
        error.code = "AUTHORITY_DENIED";
        throw error;
      }
      return call("cancel", {
        laneId: lane.controlId ?? lane.id,
        expectedThreadId: preview.expectedThreadId,
        expectedTurnId: preview.expectedTurnId,
        confirmationToken: preview.confirmationToken
      }, lane);
    }
  });
}

function parseArguments(argv) {
  let benchmark = false;
  let plain = false;
  let draftPath = null;
  for (const argument of argv) {
    if (argument === "--benchmark-startup") benchmark = true;
    else if (argument === "--plain") plain = true;
    else if (argument.startsWith("--")) {
      throw new Error(`Unknown Fleet Console argument: ${argument}`);
    } else if (draftPath === null) draftPath = argument;
    else throw new Error("Fleet Console accepts at most one Claude draft path");
  }
  return { benchmark, plain, draftPath };
}

function benchmarkStartup(now) {
  const start = now();
  const view = buildViewModel(emptySnapshot(process.cwd()), null, "lanes");
  renderScreen(view, { columns: 100, rows: 28 }, {
    color: false,
    unicode: true,
    motion: false
  });
  return Math.max(0, now() - start);
}

export async function runEntry(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return EXIT_INVALID_INPUT;
  }

  if (parsed.benchmark) {
    const startupMs = benchmarkStartup(dependencies.now ?? performance.now.bind(performance));
    stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      startupMs,
      backgroundProcesses: 0
    })}\n`);
    return EXIT_SUCCESS;
  }

  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? { stdin: process.stdin, stdout, lifecycle: process };
  try {
    const runtime = dependencies.runtime ?? await createSupervisorRuntime({
      cwd,
      env,
      platform: dependencies.platform,
      home: dependencies.home,
      ensureSupervisor: dependencies.ensureSupervisor,
      requestSupervisor: dependencies.requestSupervisor
    });
    let key, dataDir, saved = null, preferenceWarning = null;
    try {
      key = await workspaceKey(cwd);
      dataDir = getFleetDataDir(env, dependencies.platform ?? process.platform, dependencies.home ?? os.homedir());
      saved = await readConsolePreferences(dataDir, key);
    }
    catch (error) { preferenceWarning = error.message; }
    await (dependencies.runConsole ?? runConsole)({
      cwd,
      draftPath: parsed.draftPath ? path.resolve(parsed.draftPath) : null,
      savedViewState: saved,
      preferenceWarning,
      saveViewState: saved ? async (value) => {
        saved = await writeConsolePreferences(dataDir, key, value, saved.revision);
      } : undefined,
      io,
      readSnapshot: dependencies.readSnapshot ?? createFileStateReader({
        cwd,
        env,
        platform: dependencies.platform,
        home: dependencies.home,
        runtime
      }),
      spawnEditor: dependencies.spawnEditor ?? createOriginalEditor(env),
      runtime,
      preferences: {
        color: parsed.plain !== true && env.NO_COLOR === undefined,
        unicode: env.FLEET_ASCII !== "1",
        reducedMotion: env.FLEET_REDUCED_MOTION === "1",
        version: env.FLEET_INTEGRATION_VERSION ?? "unknown"
      }
    });
    return EXIT_SUCCESS;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return EXIT_INVALID_INPUT;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await runEntry(process.argv.slice(2));
