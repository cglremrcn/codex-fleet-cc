#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runConsole } from "./lib/console-controller.mjs";
import { getFleetDataDir, resolveOwnedPath, workspaceKey } from "./lib/paths.mjs";
import { readWorkspaceState } from "./lib/safe-state.mjs";
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
  return async function readState() {
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
    await (dependencies.runConsole ?? runConsole)({
      cwd,
      draftPath: parsed.draftPath ? path.resolve(parsed.draftPath) : null,
      io,
      readSnapshot: dependencies.readSnapshot ?? createFileStateReader({
        cwd,
        env,
        platform: dependencies.platform,
        home: dependencies.home
      }),
      spawnEditor: dependencies.spawnEditor ?? createOriginalEditor(env),
      preferences: {
        color: parsed.plain !== true && env.NO_COLOR === undefined,
        unicode: env.FLEET_ASCII !== "1",
        reducedMotion: env.FLEET_REDUCED_MOTION === "1"
      }
    });
    return EXIT_SUCCESS;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return EXIT_INVALID_INPUT;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runEntry(process.argv.slice(2));
