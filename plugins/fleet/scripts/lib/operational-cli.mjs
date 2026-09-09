import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, runCli } from "./cli.mjs";
import { LANE_STATUSES } from "./domain.mjs";
import { getFleetDataDir, resolveOwnedPath, workspaceKey } from "./paths.mjs";
import { renderPlainStatus, selectStatusLanes, summarizeStatusLane } from "./plain-status.mjs";
import { readWorkspaceState } from "./safe-state.mjs";
import {
  listRegisteredWorkspaces,
  resolveRegisteredWorkspace
} from "./workspace-registry.mjs";
import {
  ensureSupervisor,
  probeExistingSupervisor,
  readSupervisorManifest,
  requestSupervisor
} from "./supervisor-protocol.mjs";

const DEFAULT_RESULT_WAIT_MS = 600_000;
const DEFAULT_WATCH_MS = 4 * 60 * 60_000;
const DEFAULT_STALL_MS = 20 * 60_000;
const MAX_WAIT_MS = 3_600_000;
const MAX_WATCH_MS = 4 * 60 * 60_000;
const MAX_STALL_MS = 24 * 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_REF = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const STATUS_SET = new Set(LANE_STATUSES);

const HELP = Object.freeze({
  root: [
    "Codex Fleet operational CLI",
    "",
    "Usage: fleet <command> [options]",
    "",
    "Recovery and observation:",
    "  result --lane <id> --wait [--timeout-ms <ms>]  Wait without shell polling; default 10 minutes.",
    "  watch [--timeout-ms <ms>] [--stall-ms <ms>]    Long-poll terminal/attention/stall events.",
    "  reconcile <id> [--assume-not-started --evidence <ref>]",
    "  resolve <id> --evidence <ref> [--outcome complete|failed|cancelled]",
    "  archive <id>                                  Hide a terminal lane from normal status.",
    "  cancel <id>                                   Identity-bound one-command cancellation shortcut.",
    "",
    "Discovery and status:",
    "  models [--refresh] [--workspace <path>]        Refresh requires an idle Fleet runtime.",
    "  status [--archived|--include-archived]         Archived lanes are hidden by default.",
    "  status --workspace <path>                      Warns about sibling-worktree Fleet ledgers.",
    "",
    "Contracts:",
    "  start/follow-up accept bounded JSON via --stdin or --contract.",
    "  Run `fleet help start` or `fleet help follow-up` for the contract shape.",
    ""
  ].join("\n"),
  start: [
    "Usage: fleet start --stdin|--contract <file> [--json]",
    "",
    "Root-only fields include modelPolicy:\"runtime\" and sharedContext.",
    "Per-lane verificationPlan separates start, completion, and controller-owned checks.",
    "For cross-worktree lineage, retryOf may be <workspaceKey>:<laneId>.",
    ""
  ].join("\n"),
  "follow-up": [
    "Usage: fleet follow-up --stdin|--contract <file> [--json]",
    "",
    "Contract:",
    '{"schemaVersion":1,"workspacePath":"ABSOLUTE_PATH","laneId":"LANE_ID","message":"FOLLOW_UP"}',
    "",
    "Unknown mutable outcomes must be reconciled before another mutable continuation.",
    ""
  ].join("\n"),
  cancel: [
    "Usage:",
    "  fleet cancel <laneId> --workspace <path> [--json]",
    "  fleet cancel --stdin|--contract <file> [--confirm] [--json]  # low-level protocol",
    "",
    "The shortcut performs preview + identity-bound confirmation internally. If the target turn moves,",
    "confirmation is refused. Review the returned touchedFiles before cleanup or revert.",
    ""
  ].join("\n"),
  result: [
    "Usage: fleet result --lane <id> [--wait] [--timeout-ms <ms>] [--pretty|--summary] [--json]",
    "",
    "`--wait` defaults to 600000 ms and uses the supervisor waiter instead of a shell sleep loop.",
    "A wait timeout is not a lane failure; timedOut:true preserves the current live lane state.",
    ""
  ].join("\n"),
  watch: [
    "Usage: fleet watch [--workspace <path>] [--timeout-ms <ms>] [--stall-ms <ms>] [--json]",
    "",
    "Returns on lane terminal, controller attention, intervention, queue stall, or unknown continuation.",
    "Default timeout: 4h. Default queued-stall threshold: 20m.",
    ""
  ].join("\n"),
  reconcile: [
    "Usage:",
    "  fleet reconcile <laneId> --workspace <path> [--json]",
    "  fleet reconcile <laneId> --assume-not-started --evidence <ref> --workspace <path> [--json]",
    "",
    "Fleet probes Codex history first. Explicit assume-not-started is allowed only with operator evidence.",
    ""
  ].join("\n"),
  resolve: [
    "Usage: fleet resolve <laneId> --evidence <ref> [--outcome complete|failed|cancelled] --workspace <path>",
    "",
    "Records explicit reconciliation for outcome_unknown/interrupted work. It never invents verification.",
    ""
  ].join("\n"),
  archive: [
    "Usage: fleet archive <laneId> --workspace <path> [--json]",
    "",
    "Archives only terminal lanes. Normal status hides archived lanes; use --archived to inspect them.",
    ""
  ].join("\n"),
  models: [
    "Usage: fleet models [--refresh] [--workspace <path>] [--json]",
    "",
    "--refresh restarts only an idle Fleet runtime before rediscovering the Codex model catalogue.",
    ""
  ].join("\n"),
  status: [
    "Usage: fleet status [--workspace <path>] [--json] [--summary] [--all|--limit N]",
    "                    [--status <value> ...] [--since 30m|12h|7d]",
    "                    [--archived|--include-archived]",
    "",
    "Normal status hides archived lanes and reports live queue blockers when a supervisor already exists.",
    "An empty selected ledger may include sibling-worktree routing hints instead of implying global absence.",
    ""
  ].join("\n")
});

class OperationalInputError extends Error {}

function normalizeSink(value, fallback) {
  if (typeof value === "function") return value;
  if (Array.isArray(value)) return (text) => value.push(text);
  return fallback;
}

function ioOptions(options = {}) {
  return {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    home: options.home ?? os.homedir(),
    stdout: normalizeSink(options.stdout, (text) => process.stdout.write(text)),
    stderr: normalizeSink(options.stderr, (text) => process.stderr.write(text)),
    dependencies: options.dependencies ?? {}
  };
}

function write(io, stream, text) {
  const value = String(text);
  io[stream](value.endsWith("\n") ? value : `${value}\n`);
}

function safeId(value, label = "lane id") {
  if (!SAFE_ID.test(value ?? "")) {
    throw new OperationalInputError(`${label} must be a 1-64 character URL-safe identifier.`);
  }
  return value;
}

function safeRef(value, label = "evidence reference") {
  if (!SAFE_REF.test(value ?? "")) {
    throw new OperationalInputError(`${label} must contain 1-512 characters without control characters.`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value ?? ""))) {
    throw new OperationalInputError(`${label} must be an integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new OperationalInputError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function sinceDuration(value) {
  const match = /^(\d+)([mhd])$/u.exec(value ?? "");
  if (!match) throw new OperationalInputError("--since must use 30m, 12h, or 7d style syntax.");
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const duration = Number(match[1]) * unit;
  if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 365 * 86_400_000) {
    throw new OperationalInputError("--since must be between 1m and 365d.");
  }
  return duration;
}

function parseOptions(tokens, spec = {}, command = "command") {
  const values = new Map();
  const booleans = new Set();
  const positionals = [];
  const repeatable = new Map();
  const valueFlags = new Set(spec.values ?? []);
  const booleanFlags = new Set(spec.booleans ?? []);
  const repeatableFlags = new Set(spec.repeatable ?? []);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (repeatableFlags.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OperationalInputError(`Flag ${token} requires a value.`);
      }
      repeatable.set(token, [...(repeatable.get(token) ?? []), value]);
      index += 1;
      continue;
    }
    if (booleanFlags.has(token)) {
      if (booleans.has(token) || values.has(token)) {
        throw new OperationalInputError(`Duplicate flag: ${token}.`);
      }
      booleans.add(token);
      continue;
    }
    if (valueFlags.has(token)) {
      if (values.has(token) || booleans.has(token)) {
        throw new OperationalInputError(`Duplicate flag: ${token}.`);
      }
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OperationalInputError(`Flag ${token} requires a value.`);
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    throw new OperationalInputError(`Flag ${token} is not valid for ${command}. Run fleet ${command} --help.`);
  }
  return { values, booleans, positionals, repeatable };
}

async function contextFor(workspacePath, io) {
  const workspace = path.resolve(workspacePath ?? io.cwd);
  const key = await workspaceKey(workspace);
  const dataDir = getFleetDataDir(io.env, io.platform, io.home);
  const root = resolveOwnedPath(dataDir, "workspaces", key);
  return { workspace, key, dataDir, root };
}

async function readState(root, dependencies) {
  if (typeof dependencies.readStateWithoutCreating === "function") {
    return dependencies.readStateWithoutCreating(root);
  }
  try {
    const metadata = await fs.stat(root);
    if (!metadata.isDirectory()) throw new Error("Fleet workspace state root is not a directory.");
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, lanes: [], updatedAt: null };
    throw error;
  }
  return readWorkspaceState(root);
}

async function liveRequest(context, method, params, io, requestTimeoutMs = 10_000) {
  const ensure = io.dependencies.ensureSupervisor ?? ensureSupervisor;
  const request = io.dependencies.requestSupervisor ?? requestSupervisor;
  const manifest = await ensure({
    dataDir: context.dataDir,
    workspaceKey: context.key,
    workspacePath: context.workspace,
    scriptPath: fileURLToPath(new URL("../fleet-supervisor.mjs", import.meta.url)),
    nodeExecutable: process.execPath,
    env: io.env
  });
  return request({
    address: manifest.address,
    workspaceKey: context.key,
    token: manifest.token,
    method,
    params,
    timeoutMs: requestTimeoutMs
  });
}

async function existingSupervisorStatus(context, io) {
  const readManifest = io.dependencies.readSupervisorManifest ?? readSupervisorManifest;
  const request = io.dependencies.requestSupervisor ?? requestSupervisor;
  try {
    const manifest = await readManifest({
      dataDir: context.dataDir,
      workspaceKey: context.key,
      platform: io.platform
    });
    if (!manifest) return null;
    return await request({
      address: manifest.address,
      workspaceKey: context.key,
      token: manifest.token,
      method: "status",
      params: {},
      timeoutMs: 2_000
    });
  } catch {
    return null;
  }
}

function inspectBranch(workspace, dependencies) {
  if (typeof dependencies.inspectBranch === "function") return dependencies.inspectBranch(workspace);
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: workspace,
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000
  });
  if (result.status !== 0) return "unknown";
  const branch = result.stdout.trim().split(/\r?\n/u)[0];
  return branch && branch.length <= 256 ? branch : "unknown";
}

function gitCommonDir(workspace, dependencies) {
  if (typeof dependencies.gitCommonDir === "function") return dependencies.gitCommonDir(workspace);
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: workspace,
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const raw = result.stdout.trim().split(/\r?\n/u)[0];
  return path.resolve(workspace, raw);
}

function comparablePath(value, platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function relatedWorktreeLedgers(context, io) {
  if (typeof io.dependencies.relatedWorktreeLedgers === "function") {
    return io.dependencies.relatedWorktreeLedgers(context);
  }
  const currentCommon = gitCommonDir(context.workspace, io.dependencies);
  if (!currentCommon) return [];
  let projects;
  try {
    projects = await (io.dependencies.listRegisteredWorkspaces ?? listRegisteredWorkspaces)(context.dataDir);
  } catch {
    return [];
  }
  const related = [];
  for (const project of projects.projects ?? []) {
    if (!project.registered || project.workspaceKey === context.key) continue;
    try {
      const registered = await (io.dependencies.resolveRegisteredWorkspace ?? resolveRegisteredWorkspace)(
        context.dataDir,
        project.workspaceKey
      );
      const candidateCommon = gitCommonDir(registered.workspacePath, io.dependencies);
      if (
        !candidateCommon
        || comparablePath(candidateCommon, io.platform) !== comparablePath(currentCommon, io.platform)
      ) {
        continue;
      }
      const root = resolveOwnedPath(context.dataDir, "workspaces", project.workspaceKey);
      const state = await readState(root, io.dependencies);
      const visible = state.lanes.filter((lane) => !lane.archivedAt);
      if (visible.length === 0) continue;
      related.push(Object.freeze({
        workspaceKey: project.workspaceKey,
        name: project.name,
        laneCount: visible.length,
        attentionCount: visible.filter((lane) => (
          lane.status === "outcome_unknown"
          || lane.status === "blocked"
          || lane.status === "interrupted"
          || lane.controllerRequest
        )).length
      }));
    } catch {
      // Ignore stale/unreadable registrations; do not guess or expose paths.
    }
  }
  return related.slice(0, 32);
}

function renderQueueBlocker(blocker) {
  if (!blocker) return null;
  const holders = Array.isArray(blocker.heldBy)
    ? blocker.heldBy.map((item) => item.laneId).filter(Boolean).join(", ")
    : "";
  return `QUEUE BLOCKED [${String(blocker.kind)}]${holders ? ` by ${holders}` : ""}: ${String(blocker.message ?? "")}`;
}

function renderOperationalStatus(payload) {
  const lines = [renderPlainStatus(payload).trimEnd()];
  for (const lane of payload.lanes ?? []) {
    const blocker = renderQueueBlocker(lane.queueBlocker);
    if (blocker) lines.push(`Lane ${lane.id}: ${blocker}`);
  }
  if ((payload.selection?.archivedHidden ?? 0) > 0) {
    lines.push(`${payload.selection.archivedHidden} archived lane(s) hidden; use --archived or --include-archived.`);
  }
  const related = payload.workspaceRouting?.relatedWorktrees ?? [];
  if (related.length > 0) {
    lines.push(
      `RELATED WORKTREE LEDGERS: ${related.map((item) => (
        `${item.name} (${item.workspaceKey.slice(0, 8)}, ${item.laneCount} lane${item.laneCount === 1 ? "" : "s"})`
      )).join("; ")}.`
    );
    lines.push("The selected --workspace has a different Fleet ledger; use the intended worktree path.");
  }
  return `${lines.join("\n")}\n`;
}

async function runStatus(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace", "--limit", "--since"],
    booleans: ["--json", "--all", "--summary", "--archived", "--include-archived"],
    repeatable: ["--status"]
  }, "status");
  if (parsed.positionals.length > 0) throw new OperationalInputError("status does not accept positional input.");
  if (parsed.booleans.has("--all") && parsed.values.has("--limit")) {
    throw new OperationalInputError("Use either --all or --limit, not both.");
  }
  if (parsed.booleans.has("--archived") && parsed.booleans.has("--include-archived")) {
    throw new OperationalInputError("Use either --archived or --include-archived, not both.");
  }
  const statuses = parsed.repeatable.get("--status") ?? [];
  const invalid = statuses.filter((status) => !STATUS_SET.has(status));
  if (invalid.length > 0) throw new OperationalInputError(`Invalid --status value: ${invalid.join(", ")}.`);

  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const state = await readState(context.root, io.dependencies);
  const live = await existingSupervisorStatus(context, io);
  const allLanes = Array.isArray(live?.lanes) ? live.lanes : state.lanes;
  const archivedCount = allLanes.filter((lane) => Boolean(lane.archivedAt)).length;
  const archiveMode = parsed.booleans.has("--archived")
    ? "only"
    : parsed.booleans.has("--include-archived")
      ? "include"
      : "hide";
  const source = allLanes.filter((lane) => (
    archiveMode === "include"
    || (archiveMode === "only" ? Boolean(lane.archivedAt) : !lane.archivedAt)
  ));
  const limit = parsed.booleans.has("--all")
    ? undefined
    : parsed.values.has("--limit")
      ? integer(parsed.values.get("--limit"), "--limit", 1, 256)
      : parsed.booleans.has("--json")
        ? undefined
        : 32;
  const now = typeof io.dependencies.now === "function" ? io.dependencies.now() : Date.now();
  const sinceMs = parsed.values.has("--since") ? now - sinceDuration(parsed.values.get("--since")) : null;
  const selection = selectStatusLanes(source, { statuses, sinceMs, limit });
  const probe = io.dependencies.probeExistingSupervisor ?? probeExistingSupervisor;
  const runtime = await probe({
    dataDir: context.dataDir,
    workspaceKey: context.key,
    platform: io.platform,
    timeoutMs: 2_000
  }).catch(() => ({ health: "unavailable", protocol: "unknown", active: 0 }));
  const related = selection.lanes.length === 0 ? await relatedWorktreeLedgers(context, io) : [];
  const lanes = parsed.booleans.has("--summary")
    ? selection.lanes.map((lane) => {
      const summary = summarizeStatusLane(lane);
      if (lane.queueBlocker) summary.queueBlocker = lane.queueBlocker;
      if (lane.archivedAt) summary.archivedAt = lane.archivedAt;
      if (Array.isArray(lane.touchedFiles)) summary.touchedFileCount = lane.touchedFiles.length;
      return summary;
    })
    : selection.lanes;
  const payload = {
    schemaVersion: 1,
    workspaceKey: context.key,
    workspace: { name: path.basename(context.workspace), branch: inspectBranch(context.workspace, io.dependencies) },
    runtime,
    updatedAt: state.updatedAt,
    lanes,
    ...(parsed.booleans.has("--summary") ? {
      summaryOnly: true,
      detail: "Use result for full evidence; summary fields do not authorize actions."
    } : {}),
    selection: {
      ...Object.fromEntries(Object.entries(selection).filter(([key]) => key !== "lanes")),
      archivedHidden: archiveMode === "hide" ? archivedCount : 0,
      archiveMode
    },
    ...(related.length > 0 ? {
      workspaceRouting: {
        selectedWorkspaceKey: context.key,
        relatedWorktrees: related,
        hint: "The selected workspace has a distinct Fleet ledger; choose the intended registered worktree."
      }
    } : {})
  };

  if (parsed.booleans.has("--json")) write(io, "stdout", JSON.stringify(payload));
  else write(io, "stdout", renderOperationalStatus(payload));
  return selection.hasOutcomeUnknown ? EXIT_CODES.outcomeUnknown : EXIT_CODES.success;
}

async function runModelsRefresh(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace"],
    booleans: ["--json"]
  }, "models");
  if (parsed.positionals.length > 0) throw new OperationalInputError("models does not accept positional input.");
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const payload = await liveRequest(context, "models", { refresh: true }, io, 30_000);
  if (parsed.booleans.has("--json")) {
    write(io, "stdout", JSON.stringify(payload));
  } else {
    const age = payload.ageMs === null || payload.ageMs === undefined ? "unknown" : `${payload.ageMs}ms`;
    write(io, "stdout", [
      `Fleet model catalogue refreshed (${payload.models?.length ?? 0} models; age ${age}).`,
      ...(payload.models ?? []).map((entry) => `${entry.model}: ${(entry.efforts ?? []).join(", ")}`)
    ].join("\n"));
  }
  return EXIT_CODES.success;
}

async function runResultWait(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace", "--lane", "--timeout-ms"],
    booleans: ["--json", "--pretty", "--summary", "--wait"]
  }, "result");
  if (parsed.positionals.length > 0) throw new OperationalInputError("result does not accept positional input.");
  if (parsed.booleans.has("--pretty") && parsed.booleans.has("--summary")) {
    throw new OperationalInputError("Use either --pretty or --summary, not both.");
  }
  const laneId = safeId(parsed.values.get("--lane"), "result lane id");
  const timeoutMs = parsed.values.has("--timeout-ms")
    ? integer(parsed.values.get("--timeout-ms"), "--timeout-ms", 100, MAX_WAIT_MS)
    : DEFAULT_RESULT_WAIT_MS;
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const waited = await liveRequest(
    context,
    "waitForLane",
    { laneId, timeoutMs },
    io,
    Math.min(timeoutMs + 10_000, MAX_WAIT_MS + 10_000)
  );
  const payload = Object.freeze({
    ...waited,
    lanes: waited.lane ? [waited.lane] : []
  });

  if (parsed.booleans.has("--json")) {
    write(io, "stdout", JSON.stringify(payload));
  } else if (parsed.booleans.has("--pretty")) {
    write(io, "stdout", JSON.stringify(payload, null, 2));
  } else if (parsed.booleans.has("--summary")) {
    if (waited.timedOut) {
      const blocker = renderQueueBlocker(waited.lane?.queueBlocker);
      write(
        io,
        "stdout",
        `Lane ${laneId} is still ${waited.lane?.status ?? "non-terminal"} after ${waited.elapsedMs}ms; `
          + `the wait timed out, the lane did not fail.${blocker ? ` ${blocker}` : ""}`
      );
    } else {
      write(
        io,
        "stdout",
        `Lane ${laneId}: ${waited.lane?.status ?? "unknown"}. ${String(waited.lane?.lastMessage ?? waited.lane?.exitReason ?? "")}`
      );
    }
  } else {
    write(io, "stdout", JSON.stringify(payload));
  }
  return waited.lane?.status === "outcome_unknown" ? EXIT_CODES.outcomeUnknown : EXIT_CODES.success;
}

async function runWatch(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace", "--timeout-ms", "--stall-ms"],
    booleans: ["--json", "--pretty"]
  }, "watch");
  if (parsed.positionals.length > 0) throw new OperationalInputError("watch does not accept positional input.");
  const timeoutMs = parsed.values.has("--timeout-ms")
    ? integer(parsed.values.get("--timeout-ms"), "--timeout-ms", 1, MAX_WATCH_MS)
    : DEFAULT_WATCH_MS;
  const stallMs = parsed.values.has("--stall-ms")
    ? integer(parsed.values.get("--stall-ms"), "--stall-ms", 60_000, MAX_STALL_MS)
    : DEFAULT_STALL_MS;
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const payload = await liveRequest(
    context,
    "watchForEvent",
    { timeoutMs, stallMs },
    io,
    timeoutMs + 10_000
  );
  if (parsed.booleans.has("--json")) write(io, "stdout", JSON.stringify(payload));
  else if (parsed.booleans.has("--pretty")) write(io, "stdout", JSON.stringify(payload, null, 2));
  else if (payload.changed) write(io, "stdout", `Fleet event ${payload.event.kind} on ${payload.event.laneId}: ${JSON.stringify(payload.event)}`);
  else write(io, "stdout", `Fleet watch ended without a change (${payload.reason ?? "timeout"}) after ${payload.elapsedMs ?? 0}ms.`);
  return payload.event?.status === "outcome_unknown" ? EXIT_CODES.outcomeUnknown : EXIT_CODES.success;
}

async function runReconcile(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace", "--evidence"],
    booleans: ["--json", "--pretty", "--assume-not-started"]
  }, "reconcile");
  if (parsed.positionals.length !== 1) throw new OperationalInputError("reconcile requires exactly one lane id.");
  const laneId = safeId(parsed.positionals[0]);
  const assumeNotStarted = parsed.booleans.has("--assume-not-started");
  const evidenceRef = parsed.values.has("--evidence") ? safeRef(parsed.values.get("--evidence")) : undefined;
  if (assumeNotStarted && !evidenceRef) throw new OperationalInputError("--assume-not-started requires --evidence <ref>.");
  if (!assumeNotStarted && evidenceRef) {
    throw new OperationalInputError("--evidence is only accepted with --assume-not-started for continuation reconciliation.");
  }
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const payload = await liveRequest(context, "reconcileContinuation", {
    laneId,
    assumeNotStarted,
    ...(evidenceRef ? { evidenceRef } : {})
  }, io, 30_000);
  if (parsed.booleans.has("--json")) write(io, "stdout", JSON.stringify(payload));
  else if (parsed.booleans.has("--pretty")) write(io, "stdout", JSON.stringify(payload, null, 2));
  else write(io, "stdout", `${payload.resolved ? "Resolved" : "Unresolved"} ${laneId}: ${payload.resolution}. ${payload.message ?? payload.reason ?? ""}`);
  return payload.lane?.status === "outcome_unknown" && payload.resolved
    ? EXIT_CODES.outcomeUnknown
    : EXIT_CODES.success;
}

async function runResolve(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace", "--evidence", "--outcome"],
    booleans: ["--json", "--pretty"]
  }, "resolve");
  if (parsed.positionals.length !== 1) throw new OperationalInputError("resolve requires exactly one lane id.");
  const laneId = safeId(parsed.positionals[0]);
  const evidenceRef = safeRef(parsed.values.get("--evidence"));
  const outcome = parsed.values.get("--outcome") ?? "complete";
  if (!["complete", "failed", "cancelled"].includes(outcome)) {
    throw new OperationalInputError("--outcome must be complete, failed, or cancelled.");
  }
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const payload = await liveRequest(context, "resolve", { laneId, evidenceRef, outcome }, io, 30_000);
  if (parsed.booleans.has("--json")) write(io, "stdout", JSON.stringify(payload));
  else if (parsed.booleans.has("--pretty")) write(io, "stdout", JSON.stringify(payload, null, 2));
  else write(io, "stdout", `Lane ${laneId} reconciled as ${payload.status} with ${evidenceRef}.`);
  return EXIT_CODES.success;
}

async function runArchive(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace"],
    booleans: ["--json", "--pretty"]
  }, "archive");
  if (parsed.positionals.length !== 1) throw new OperationalInputError("archive requires exactly one lane id.");
  const laneId = safeId(parsed.positionals[0]);
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const payload = await liveRequest(context, "archive", { laneId }, io, 30_000);
  if (parsed.booleans.has("--json")) write(io, "stdout", JSON.stringify(payload));
  else if (parsed.booleans.has("--pretty")) write(io, "stdout", JSON.stringify(payload, null, 2));
  else write(io, "stdout", `Archived terminal lane ${laneId} at ${payload.archivedAt}.`);
  return EXIT_CODES.success;
}

async function runCancelShortcut(tokens, io) {
  const parsed = parseOptions(tokens, {
    values: ["--workspace"],
    booleans: ["--json", "--pretty"]
  }, "cancel");
  if (parsed.positionals.length !== 1) throw new OperationalInputError("cancel shortcut requires exactly one lane id.");
  const laneId = safeId(parsed.positionals[0]);
  const context = await contextFor(parsed.values.get("--workspace") ?? io.cwd, io);
  const preview = await liveRequest(context, "cancel", { laneId }, io, 30_000);
  const payload = await liveRequest(context, "cancel", {
    laneId,
    confirmationToken: preview.confirmationToken,
    shortcut: true
  }, io, 30_000);
  const result = {
    ...payload,
    previewTouchedFiles: preview.touchedFiles ?? [],
    touchedFiles: payload.touchedFiles ?? preview.touchedFiles ?? []
  };
  if (parsed.booleans.has("--json")) write(io, "stdout", JSON.stringify(result));
  else if (parsed.booleans.has("--pretty")) write(io, "stdout", JSON.stringify(result, null, 2));
  else {
    const touched = result.touchedFiles.length > 0
      ? ` Review touched files: ${result.touchedFiles.join(", ")}.`
      : " Fleet observed no touched-file events for this lane.";
    write(io, "stdout", `Cancellation accepted for ${laneId}.${touched}`);
  }
  return EXIT_CODES.success;
}

function helpFor(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return HELP.root;
  if (argv[0] === "help") {
    if (argv.length > 2) throw new OperationalInputError("help accepts at most one command.");
    const command = argv[1] ?? "root";
    return HELP[command] ?? `No extended operational help for ${command}. Run fleet --help.`;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.length !== 2 || !["--help", "-h"].includes(argv[1])) {
      throw new OperationalInputError("--help must be used as `fleet <command> --help`.");
    }
    return HELP[argv[0]] ?? `No extended operational help for ${argv[0]}. Run fleet --help.`;
  }
  return null;
}

function stripRefresh(tokens) {
  const index = tokens.indexOf("--refresh");
  return index === -1 ? tokens : [...tokens.slice(0, index), ...tokens.slice(index + 1)];
}

export async function runOperationalCli(argv, options = {}) {
  const io = ioOptions(options);
  try {
    const help = helpFor(argv);
    if (help !== null) {
      write(io, "stdout", help);
      return EXIT_CODES.success;
    }
    const [command, ...tokens] = argv;
    if (command === "status") return await runStatus(tokens, io);
    if (command === "models" && tokens.includes("--refresh")) return await runModelsRefresh(stripRefresh(tokens), io);
    if (command === "result" && tokens.includes("--wait")) return await runResultWait(tokens, io);
    if (command === "watch") return await runWatch(tokens, io);
    if (command === "reconcile") return await runReconcile(tokens, io);
    if (command === "resolve") return await runResolve(tokens, io);
    if (command === "archive") return await runArchive(tokens, io);
    if (
      command === "cancel"
      && !tokens.includes("--stdin")
      && !tokens.includes("--contract")
      && tokens.some((token) => !token.startsWith("--"))
    ) {
      return await runCancelShortcut(tokens, io);
    }
    return await runCli(argv, options);
  } catch (error) {
    const exitCode = error instanceof OperationalInputError
      ? EXIT_CODES.invalidInput
      : EXIT_CODES.runtimeUnavailable;
    write(io, "stderr", error?.message ?? String(error));
    return exitCode;
  }
}
