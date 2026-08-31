import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { isTerminalStatus, LANE_STATUSES } from "./domain.mjs";
import {
  buildStartContractTemplate,
  contractTemplateDefinition,
  listContractTemplates
} from "./contract-templates.mjs";
import { runDoctor } from "./doctor.mjs";
import { getFleetDataDir, resolveOwnedPath, workspaceKey } from "./paths.mjs";
import { renderPlainStatus, selectStatusLanes } from "./plain-status.mjs";
import { createRuntime } from "./runtime-adapter.mjs";
import { readWorkspaceState } from "./safe-state.mjs";
import {
  applySetup,
  previewSetup,
  previewUninstallSetup,
  uninstallSetup
} from "./setup.mjs";
import { previewSupportBundle, writeSupportBundle } from "./support-bundle.mjs";
import {
  SupervisorRequestTimeoutError,
  ensureSupervisor,
  probeExistingSupervisor,
  requestSupervisor
} from "./supervisor-protocol.mjs";
import {
  StartContractValidationError,
  validateStartContract
} from "./start-contract.mjs";

export const EXIT_CODES = Object.freeze({
  success: 0,
  invalidInput: 2,
  authorityDenied: 3,
  runtimeUnavailable: 4,
  outcomeUnknown: 5
});

const MAX_CONTRACT_BYTES = 128 * 1024;
const COMMANDS = new Set([
  "doctor",
  "init",
  "start",
  "status",
  "result",
  "follow-up",
  "cancel",
  "export",
  "setup",
  "uninstall"
]);
const BOOLEAN_FLAGS = new Set([
  "--json",
  "--stdin",
  "--confirm",
  "--wait",
  "--list",
  "--all",
  "--pretty",
  "--summary"
]);
const VALUE_FLAGS = new Set([
  "--contract",
  "--workspace",
  "--lane",
  "--output",
  "--confirm-token",
  "--timeout-ms",
  "--template",
  "--objective",
  "--confirmation-ref",
  "--limit",
  "--status",
  "--since"
]);
const STRUCTURED_COMMANDS = new Set(["start", "follow-up", "cancel"]);
const COMMAND_FLAGS = Object.freeze({
  doctor: new Set(["--json", "--workspace"]),
  init: new Set([
    "--json",
    "--list",
    "--workspace",
    "--template",
    "--objective",
    "--confirmation-ref"
  ]),
  start: new Set(["--json", "--stdin", "--contract"]),
  status: new Set([
    "--json",
    "--workspace",
    "--all",
    "--limit",
    "--status",
    "--since"
  ]),
  result: new Set([
    "--json",
    "--workspace",
    "--lane",
    "--wait",
    "--timeout-ms",
    "--pretty",
    "--summary"
  ]),
  "follow-up": new Set(["--json", "--stdin", "--contract"]),
  cancel: new Set(["--json", "--stdin", "--contract", "--confirm"]),
  export: new Set(["--json", "--workspace", "--output", "--confirm-token"]),
  setup: new Set(["--json", "--workspace", "--confirm-token"]),
  uninstall: new Set(["--json", "--workspace", "--confirm-token"])
});

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

class InvalidInputError extends CliError {
  constructor(message) {
    super(message, EXIT_CODES.invalidInput);
  }
}

class AuthorityDeniedError extends CliError {
  constructor(message) {
    super(message, EXIT_CODES.authorityDenied);
  }
}

class RuntimeUnavailableError extends CliError {
  constructor(message) {
    super(message, EXIT_CODES.runtimeUnavailable);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidInputError(`${label} must be an object.`);
  }
}

function rejectUnknownProperties(value, allowed, label) {
  for (const property of Object.keys(value)) {
    if (!allowed.has(property)) {
      throw new InvalidInputError(`Unknown ${label} property: ${property}.`);
    }
  }
}

function boundedText(value, label, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new InvalidInputError(`${label} must contain between 1 and ${maximum} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new InvalidInputError(`${label} contains unsupported control characters.`);
  }
  return value;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new InvalidInputError(`A command is required: ${[...COMMANDS].join(", ")}.`);
  }
  const [command, ...tokens] = argv;
  if (!COMMANDS.has(command)) {
    throw new InvalidInputError(`Unknown command: ${String(command)}.`);
  }

  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!BOOLEAN_FLAGS.has(token) && !VALUE_FLAGS.has(token)) {
      throw new InvalidInputError(`Unknown flag for ${command}: ${token}.`);
    }
    if (flags.has(token) && token !== "--status") {
      throw new InvalidInputError(`Duplicate flag: ${token}.`);
    }
    if (BOOLEAN_FLAGS.has(token)) {
      flags.set(token, true);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new InvalidInputError(`Flag ${token} requires a value.`);
    }
    if (token === "--status") {
      flags.set(token, [...(flags.get(token) ?? []), value]);
    } else {
      flags.set(token, value);
    }
    index += 1;
  }

  if (positionals.length > 0) {
    if (STRUCTURED_COMMANDS.has(command)) {
      throw new InvalidInputError(
        `${command} accepts task data only through a JSON contract file or stdin; `
        + "inline task text is not allowed."
      );
    }
    throw new InvalidInputError(`Unexpected positional input for ${command}.`);
  }
  for (const flag of flags.keys()) {
    if (!COMMAND_FLAGS[command].has(flag)) {
      throw new InvalidInputError(`Flag ${flag} is not valid for ${command}.`);
    }
  }
  if (flags.has("--stdin") && flags.has("--contract")) {
    throw new InvalidInputError("Use either --contract or --stdin, not both.");
  }
  if (STRUCTURED_COMMANDS.has(command)) {
    if (!flags.has("--stdin") && !flags.has("--contract")) {
      throw new InvalidInputError(
        `${command} requires a JSON contract file or stdin.`
      );
    }
  } else if (flags.has("--stdin") || flags.has("--contract") || flags.has("--confirm")) {
    throw new InvalidInputError(`Structured input flags are not valid for ${command}.`);
  }
  if (flags.has("--all") && flags.has("--limit")) {
    throw new InvalidInputError("Use either --all or --limit, not both.");
  }
  if (flags.has("--pretty") && flags.has("--summary")) {
    throw new InvalidInputError("Use either --pretty or --summary, not both.");
  }

  return { command, flags };
}

function decodeUtf8(buffer) {
  if (buffer.byteLength > MAX_CONTRACT_BYTES) {
    throw new InvalidInputError("Contract input exceeds the 128 KiB limit.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new InvalidInputError("Contract input must be valid UTF-8.");
  }
}

async function readContract(parsed, io) {
  let buffer;
  if (parsed.flags.has("--stdin")) {
    buffer = await io.readStdin(MAX_CONTRACT_BYTES + 1);
  } else {
    const contractPath = path.resolve(io.cwd, parsed.flags.get("--contract"));
    let metadata;
    try {
      metadata = await fs.lstat(contractPath);
    } catch (error) {
      throw new InvalidInputError(`Cannot read contract file: ${error.message}`);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new InvalidInputError("Contract path must be a regular, non-symbolic-link file.");
    }
    if (metadata.size > MAX_CONTRACT_BYTES) {
      throw new InvalidInputError("Contract input exceeds the 128 KiB limit.");
    }
    buffer = await fs.readFile(contractPath);
  }
  const text = decodeUtf8(buffer);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidInputError(`Contract must contain one valid JSON object: ${error.message}`);
  }
}

function validateSimpleContract(value, command, confirmed) {
  const allowed = command === "follow-up"
    ? new Set(["schemaVersion", "workspacePath", "laneId", "message"])
    : new Set([
        "schemaVersion",
        "workspacePath",
        "laneId",
        "expectedThreadId",
        "expectedTurnId",
        "confirmationToken"
      ]);
  assertPlainObject(value, `${command} contract`);
  rejectUnknownProperties(value, allowed, "contract");
  if (value.schemaVersion !== 1) {
    throw new InvalidInputError(`${command} contract schemaVersion must be 1.`);
  }
  const cancellationFields = [
    value.expectedThreadId,
    value.expectedTurnId,
    value.confirmationToken
  ];
  if (command === "cancel" && !confirmed && cancellationFields.some((item) => item !== undefined)) {
    throw new InvalidInputError("Cancellation preview accepts only workspacePath and laneId.");
  }
  if (command === "cancel" && confirmed) {
    if (
      value.expectedThreadId === undefined
      || value.expectedTurnId === undefined
      || !/^[a-f0-9]{64}$/u.test(value.confirmationToken ?? "")
    ) {
      throw new AuthorityDeniedError(
        "Confirmed cancellation requires the exact preview identity and confirmation token."
      );
    }
  }
  return {
    schemaVersion: 1,
    workspacePath: path.resolve(boundedText(value.workspacePath, "workspacePath", 4096)),
    laneId: boundedText(value.laneId, "laneId", 64),
    message: command === "follow-up"
      ? boundedText(value.message, "message", MAX_CONTRACT_BYTES)
      : null,
    expectedThreadId: command === "cancel"
      ? value.expectedThreadId === null
        ? null
        : value.expectedThreadId === undefined
          ? undefined
          : boundedText(value.expectedThreadId, "expectedThreadId", 256)
      : undefined,
    expectedTurnId: command === "cancel"
      ? value.expectedTurnId === null
        ? null
        : value.expectedTurnId === undefined
          ? undefined
          : boundedText(value.expectedTurnId, "expectedTurnId", 256)
      : undefined,
    confirmationToken: command === "cancel" ? value.confirmationToken : undefined
  };
}

function boundedTimeout(value) {
  if (!/^\d+$/u.test(value ?? "")) {
    throw new InvalidInputError("--timeout-ms must be an integer.");
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 100 || milliseconds > 3_600_000) {
    throw new InvalidInputError("--timeout-ms must be between 100 and 3600000.");
  }
  return milliseconds;
}

function boundedStatusLimit(value) {
  if (!/^\d+$/u.test(value ?? "")) {
    throw new InvalidInputError("--limit must be an integer.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new InvalidInputError("--limit must be between 1 and 256.");
  }
  return limit;
}

function boundedSinceDuration(value) {
  const match = /^(\d+)([mhd])$/u.exec(value ?? "");
  if (!match) {
    throw new InvalidInputError("--since must use an integer duration such as 30m, 12h, or 7d.");
  }
  const multipliers = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const duration = Number(match[1]) * multipliers[match[2]];
  const maximum = 365 * multipliers.d;
  if (!Number.isSafeInteger(duration) || duration < multipliers.m || duration > maximum) {
    throw new InvalidInputError("--since must be between 1m and 365d.");
  }
  return duration;
}

function statusSelectionOptions(parsed, dependencies) {
  const statuses = parsed.flags.get("--status") ?? [];
  const invalid = statuses.filter((status) => !LANE_STATUSES.includes(status));
  if (invalid.length > 0) {
    throw new InvalidInputError(
      `Invalid --status value: ${invalid.join(", ")}. Choose: ${LANE_STATUSES.join(", ")}.`
    );
  }
  const duration = parsed.flags.has("--since")
    ? boundedSinceDuration(parsed.flags.get("--since"))
    : null;
  const limit = parsed.flags.has("--all")
    ? undefined
    : parsed.flags.has("--limit")
      ? boundedStatusLimit(parsed.flags.get("--limit"))
      : parsed.flags.has("--json")
        ? undefined
        : 32;
  return {
    statuses,
    sinceMs: duration === null ? undefined : (dependencies.now ?? Date.now)() - duration,
    limit
  };
}

function inspectGitBranch(workspace) {
  const result = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 65_536,
    shell: false,
    timeout: 2_000,
    windowsHide: true
  });
  if (result.status === 0) {
    const branch = result.stdout.trim().split(/\r?\n/u)[0];
    return branch && branch.length <= 256 ? branch : "unknown";
  }
  if (!result.error && result.status === 1 && !/not a git repository/iu.test(result.stderr ?? "")) {
    return "detached";
  }
  return "unknown";
}

function decodeJsonMessage(value) {
  if (typeof value !== "string" || value.length > MAX_CONTRACT_BYTES) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function decodedResult(payload) {
  return {
    ...payload,
    lanes: payload.lanes.map((lane) => ({
      ...lane,
      lastMessage: decodeJsonMessage(lane.lastMessage)
    }))
  };
}

function renderResultSummary(payload) {
  const lane = decodedResult(payload).lanes[0];
  const lines = [
    `Lane ${String(lane.id)}: ${String(lane.status)}.`,
    `${String(lane.label ?? lane.role ?? "Fleet result")}.`
  ];
  if (lane.lastMessage !== undefined && lane.lastMessage !== null) {
    lines.push(
      typeof lane.lastMessage === "string"
        ? lane.lastMessage
        : JSON.stringify(lane.lastMessage, null, 2)
    );
  }
  return lines.join("\n");
}

async function stateContext(workspacePath, io) {
  const workspace = path.resolve(workspacePath ?? io.cwd);
  const key = await workspaceKey(workspace);
  const dataDir = getFleetDataDir(io.env, io.platform, io.home);
  const root = resolveOwnedPath(dataDir, "workspaces", key);
  return { workspace, key, dataDir, root };
}

async function readStateWithoutCreating(root) {
  try {
    const metadata = await fs.stat(root);
    if (!metadata.isDirectory()) {
      throw new Error("Fleet workspace state root is not a directory.");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schemaVersion: 1, lanes: [], updatedAt: null };
    }
    throw error;
  }
  return readWorkspaceState(root);
}

async function inspectDirectory(directory, label) {
  try {
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink()) {
      return { denied: true, detail: `${label} is a symbolic link` };
    }
    if (!metadata.isDirectory()) {
      return { denied: true, detail: `${label} is not a directory` };
    }
    return { configured: true, detail: `${label} exists` };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { unknown: true, detail: `${label} has not been created` };
    }
    return { unknown: true, detail: error.message };
  }
}

async function inspectEditor(io) {
  const settingsPath = io.env.CLAUDE_SETTINGS_PATH
    ? path.resolve(io.env.CLAUDE_SETTINGS_PATH)
    : path.join(io.home, ".claude", "settings.json");
  try {
    const serialized = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(serialized);
    const editor = settings?.env?.VISUAL ?? settings?.env?.EDITOR;
    if (typeof editor === "string" && /fleet-editor\.(?:cmd|sh)/iu.test(editor)) {
      return { configured: true, detail: "Fleet external editor is configured", shortcut: "Ctrl+G" };
    }
    return { unknown: true, detail: "Fleet external editor is not configured" };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { unknown: true, detail: "Claude settings file was not found" };
    }
    return { unknown: true, detail: error.message };
  }
}

async function doctorReport(context, io, dependencies, generatedAt) {
  const runtimeFactory = dependencies.createRuntime ?? createRuntime;
  return runDoctor({
    cwd: context.workspace,
    env: io.env,
    generatedAt,
    brokerProbe: async () => {
      let runtime;
      try {
        runtime = await runtimeFactory({ cwd: context.workspace, env: io.env });
        return { smokePassed: true, protocol: "compatible" };
      } finally {
        await runtime?.close();
      }
    },
    stateProbe: () => inspectDirectory(context.root, "Fleet workspace state"),
    editorProbe: () => inspectEditor(io),
    terminalProbe: async () => io.isTTY
      ? {
          smokePassed: true,
          unicode: io.env.TERM !== "dumb",
          color: io.env.NO_COLOR === undefined
        }
      : { configured: true, detail: "Output is currently non-interactive" }
  });
}

async function runExport(parsed, context, state, io, dependencies) {
  const outputFlag = parsed.flags.get("--output");
  if (!outputFlag) {
    throw new InvalidInputError("export requires --output <absolute-or-relative-path>.");
  }
  const outputPath = path.resolve(io.cwd, outputFlag);
  const generatedAt = state.updatedAt ?? "1970-01-01T00:00:00.000Z";
  const doctor = await doctorReport(context, io, dependencies, generatedAt);
  const preview = await previewSupportBundle({
    outputPath,
    workspaceKey: context.key,
    doctor,
    state,
    events: [],
    generatedAt
  });
  const confirmation = parsed.flags.get("--confirm-token");
  if (!confirmation) {
    return {
      exitCode: EXIT_CODES.success,
      payload: { ...preview, destination: outputPath }
    };
  }
  if (confirmation !== preview.confirmationToken) {
    throw new AuthorityDeniedError("Export requires the exact preview confirmation token.");
  }
  const result = await writeSupportBundle(preview, confirmation);
  return {
    exitCode: EXIT_CODES.success,
    payload: {
      schemaVersion: 1,
      written: result.written,
      bytes: result.bytes,
      destination: outputPath,
      manifest: preview.manifest
    }
  };
}

async function requestLiveSupervisor(context, method, params, io, dependencies) {
  const ensure = dependencies.ensureSupervisor ?? ensureSupervisor;
  const request = dependencies.requestSupervisor ?? requestSupervisor;
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
    params
  });
}

async function runStart(contract, io, dependencies) {
  const context = await stateContext(contract.workspacePath, io);
  const requestStartedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
  let payload;
  try {
    payload = await requestLiveSupervisor(context, "start", contract, io, dependencies);
  } catch (error) {
    if (!(error instanceof SupervisorRequestTimeoutError) || error.requestSent !== true) {
      throw error;
    }
    const readState = dependencies.readStateWithoutCreating ?? readStateWithoutCreating;
    const state = await readState(context.root);
    const persistedById = new Map(state.lanes.map((lane) => [lane.id, lane]));
    const matches = contract.lanes.map((lane) => {
      const persisted = persistedById.get(lane.id);
      const admittedAt = Date.parse(persisted?.admittedAt ?? "");
      const exact = persisted
        && persisted.id === lane.id
        && persisted.role === lane.role
        && persisted.label === lane.label
        && persisted.model === lane.model
        && persisted.effort === lane.effort
        && persisted.checkoutKey === (lane.checkoutKey ?? context.key)
        && isDeepStrictEqual(persisted.authority, lane.authority)
        && typeof persisted.admissionId === "string"
        && persisted.admissionId.length > 0
        && Number.isFinite(admittedAt)
        && admittedAt >= Date.parse(requestStartedAt);
      return exact ? persisted : null;
    }).filter(Boolean);
    const recovered = matches.length === contract.lanes.length;
    return {
      exitCode: recovered ? EXIT_CODES.success : EXIT_CODES.outcomeUnknown,
      payload: {
        schemaVersion: 1,
        background: true,
        workspaceKey: context.key,
        admissionRecovered: recovered,
        retrySafe: false,
        admissionIds: recovered ? matches.map((lane) => lane.admissionId) : [],
        matchedLaneIds: matches.map((lane) => lane.id),
        missingLaneIds: contract.lanes
          .filter((lane) => !matches.some((match) => match.id === lane.id))
          .map((lane) => lane.id),
        requestId: error.requestId
      }
    };
  }
  return {
    exitCode: EXIT_CODES.success,
    payload: {
      ...payload,
      workspaceKey: context.key,
      admissionRecovered: false,
      retrySafe: false,
      admissionIds: (
        payload.admissionIds ?? payload.lanes?.map((lane) => lane.admissionId) ?? []
      ).filter((admissionId) => typeof admissionId === "string")
    }
  };
}

async function runControl(contract, command, io, dependencies) {
  const context = await stateContext(contract.workspacePath, io);
  const params = command === "follow-up"
    ? { laneId: contract.laneId, message: contract.message }
    : {
        laneId: contract.laneId,
        expectedThreadId: contract.expectedThreadId,
        expectedTurnId: contract.expectedTurnId,
        confirmationToken: contract.confirmationToken
      };
  try {
    const payload = await requestLiveSupervisor(
      context,
      command === "follow-up" ? "followUp" : "cancel",
      params,
      io,
      dependencies
    );
    return { exitCode: EXIT_CODES.success, payload };
  } catch (error) {
    if (command === "cancel" && /confirmation|target identity/iu.test(error.message)) {
      throw new AuthorityDeniedError(error.message);
    }
    throw error;
  }
}

async function setupContext(io) {
  const settingsRoot = io.env.CLAUDE_CONFIG_DIR
    ? path.resolve(io.env.CLAUDE_CONFIG_DIR)
    : path.join(io.home, ".claude");
  const dataRoot = io.env.CLAUDE_PLUGIN_DATA
    ? path.resolve(io.env.CLAUDE_PLUGIN_DATA)
    : resolveOwnedPath(getFleetDataDir(io.env, io.platform, io.home), "integration");
  const manifest = JSON.parse(
    await fs.readFile(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")
  );
  return {
    settingsPath: path.join(settingsRoot, "settings.json"),
    pluginDataDir: dataRoot,
    runtimeSourceDir: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    nodeExecutable: process.execPath,
    platform: io.platform,
    version: manifest.version
  };
}

async function runSetupCommand(parsed, io) {
  const options = await setupContext(io);
  const plan = await previewSetup(options);
  const confirmation = parsed.flags.get("--confirm-token");
  if (!confirmation) {
    return {
      exitCode: EXIT_CODES.success,
      payload: {
        schemaVersion: 1,
        writesPerformed: false,
        mode: plan.mode,
        previousVersion: plan.previousVersion,
        version: plan.version,
        settingsPath: plan.settingsPath,
        pluginDataDir: plan.pluginDataDir,
        runtimeTargetDir: plan.runtimeTargetDir,
        launcherPath: plan.launcherPath,
        changes: plan.changes,
        restartRequired: plan.restartRequired,
        keybindingsModified: plan.keybindingsModified,
        confirmationToken: plan.confirmationToken
      }
    };
  }
  if (confirmation !== plan.confirmationToken) {
    throw new AuthorityDeniedError("Setup requires the exact current preview confirmation token.");
  }
  const result = await applySetup({ ...plan, confirmation });
  return { exitCode: EXIT_CODES.success, payload: { schemaVersion: 1, ...result } };
}

async function runUninstallCommand(parsed, io) {
  const options = await setupContext(io);
  const preview = await previewUninstallSetup({ pluginDataDir: options.pluginDataDir });
  const confirmation = parsed.flags.get("--confirm-token");
  if (!confirmation) {
    return { exitCode: EXIT_CODES.success, payload: preview };
  }
  if (confirmation !== preview.confirmationToken) {
    throw new AuthorityDeniedError("Uninstall requires the exact current preview confirmation token.");
  }
  const result = await uninstallSetup({
    pluginDataDir: options.pluginDataDir,
    confirmationToken: confirmation
  });
  return { exitCode: EXIT_CODES.success, payload: { schemaVersion: 1, ...result } };
}

async function execute(parsed, io, dependencies) {
  if (parsed.command === "init") {
    if (parsed.flags.has("--list")) {
      if (["--workspace", "--template", "--objective", "--confirmation-ref"]
        .some((flag) => parsed.flags.has(flag))) {
        throw new InvalidInputError("init --list does not accept template construction flags.");
      }
      return {
        exitCode: EXIT_CODES.success,
        payload: { schemaVersion: 1, templates: listContractTemplates() }
      };
    }
    const templateName = parsed.flags.get("--template") ?? "research";
    const definition = contractTemplateDefinition(templateName);
    if (!definition) {
      throw new InvalidInputError(
        `Unknown Fleet template: ${templateName}. Choose: `
        + `${listContractTemplates().map((template) => template.name).join(", ")}.`
      );
    }
    const objective = parsed.flags.get("--objective");
    if (!objective) {
      throw new InvalidInputError("init requires --objective <bounded-observable-outcome>.");
    }
    const confirmationRef = parsed.flags.get("--confirmation-ref");
    if (definition.confirmationRequired && !confirmationRef) {
      throw new AuthorityDeniedError(
        `Template ${templateName} requires --confirmation-ref from the user's explicit approval.`
      );
    }
    const contract = buildStartContractTemplate({
      name: templateName,
      workspacePath: parsed.flags.get("--workspace") ?? io.cwd,
      objective: boundedText(objective, "objective", 4096),
      confirmationRef: confirmationRef
        ? boundedText(confirmationRef, "confirmationRef", 512)
        : null
    });
    return {
      exitCode: EXIT_CODES.success,
      payload: validateStartContract(contract)
    };
  }

  if (parsed.command === "doctor") {
    const context = await stateContext(parsed.flags.get("--workspace") ?? io.cwd, io);
    const report = await doctorReport(context, io, dependencies);
    return {
      exitCode: report.overall === "blocked"
        ? EXIT_CODES.runtimeUnavailable
        : EXIT_CODES.success,
      payload: report
    };
  }

  if (parsed.command === "status" || parsed.command === "result" || parsed.command === "export") {
    const context = await stateContext(parsed.flags.get("--workspace") ?? io.cwd, io);
    const readState = dependencies.readStateWithoutCreating ?? readStateWithoutCreating;
    let state = await readState(context.root);
    if (parsed.command === "export") {
      return runExport(parsed, context, state, io, dependencies);
    }
    let lanes = state.lanes;
    if (parsed.command === "result") {
      const laneId = parsed.flags.get("--lane");
      if (!laneId) {
        throw new InvalidInputError("result requires --lane <id>.");
      }
      lanes = state.lanes.filter((lane) => lane.id === laneId);
      if (lanes.length === 0) {
        throw new InvalidInputError(`Lane result was not found: ${laneId}.`);
      }
      if (parsed.flags.has("--wait")) {
        if (!parsed.flags.has("--timeout-ms")) {
          throw new InvalidInputError("result --wait requires --timeout-ms.");
        }
        const deadline = Date.now() + boundedTimeout(parsed.flags.get("--timeout-ms"));
        while (!isTerminalStatus(lanes[0].status)) {
          if (Date.now() >= deadline) {
            throw new RuntimeUnavailableError(`Timed out waiting for lane ${laneId}.`);
          }
          const liveLane = await requestLiveSupervisor(
            context,
            "result",
            { laneId },
            io,
            dependencies
          );
          lanes = [liveLane];
          if (isTerminalStatus(liveLane.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
          state = await readState(context.root);
          const persisted = state.lanes.find((lane) => lane.id === laneId);
          if (!persisted) {
            throw new RuntimeUnavailableError(
              `Lane disappeared while waiting: ${laneId}.`
            );
          }
          lanes = [persisted];
        }
      }
    }
    let selection = null;
    if (parsed.command === "status") {
      selection = selectStatusLanes(lanes, statusSelectionOptions(parsed, dependencies));
      lanes = selection.lanes;
    }
    const branchReader = dependencies.inspectBranch ?? inspectGitBranch;
    const branch = await branchReader(context.workspace);
    let runtime = { health: "unknown", protocol: "unknown" };
    if (parsed.command === "status") {
      const probe = dependencies.probeExistingSupervisor ?? probeExistingSupervisor;
      runtime = await probe({
        dataDir: context.dataDir,
        workspaceKey: context.key,
        platform: io.platform,
        timeoutMs: 2_000
      }).catch(() => ({ health: "unavailable", protocol: "unknown", active: 0 }));
    }
    const unknown = parsed.command === "status"
      ? selection.hasOutcomeUnknown
      : lanes.some((lane) => lane.status === "outcome_unknown");
    const selectionSummary = selection
      ? Object.fromEntries(Object.entries(selection).filter(([key]) => key !== "lanes"))
      : undefined;
    return {
      exitCode: unknown ? EXIT_CODES.outcomeUnknown : EXIT_CODES.success,
      payload: {
        schemaVersion: 1,
        workspaceKey: context.key,
        workspace: { name: path.basename(context.workspace), branch },
        runtime,
        updatedAt: state.updatedAt,
        lanes,
        ...(selectionSummary ? { selection: selectionSummary } : {})
      }
    };
  }

  if (parsed.command === "start") {
    const raw = await readContract(parsed, io);
    return runStart(validateStartContract(raw), io, dependencies);
  }

  if (parsed.command === "follow-up" || parsed.command === "cancel") {
    const raw = await readContract(parsed, io);
    const contract = validateSimpleContract(
      raw,
      parsed.command,
      parsed.flags.has("--confirm")
    );
    return runControl(contract, parsed.command, io, dependencies);
  }

  if (parsed.command === "setup") return runSetupCommand(parsed, io);
  if (parsed.command === "uninstall") return runUninstallCommand(parsed, io);

  throw new InvalidInputError(`Unsupported command: ${parsed.command}.`);
}

function humanSummary(command, payload, flags) {
  if (command === "init") return JSON.stringify(payload, null, 2);
  if (command === "doctor") {
    const broker = payload.checks.find((check) => check.id === "broker");
    if (broker?.diagnostic?.action === "not_stopped") {
      return [
        `Fleet doctor: ${payload.overall}.`,
        `Broker PID ${String(broker.diagnostic.pid ?? "unknown")}: Fleet did not stop `
          + `the process (${broker.diagnostic.reasonCode}).`,
        broker.diagnostic.remediation
      ].join("\n");
    }
    return `Fleet doctor: ${payload.overall}.`;
  }
  if (command === "status") {
    return renderPlainStatus(payload).trimEnd();
  }
  if (command === "result" && flags.has("--pretty")) {
    return JSON.stringify(decodedResult(payload), null, 2);
  }
  if (command === "result" && flags.has("--summary")) {
    return renderResultSummary(payload);
  }
  if (command === "start" && payload.retrySafe === false && payload.requestId) {
    return payload.admissionRecovered
      ? `Fleet recovered ${payload.admissionIds.length} admitted lane(s) after the response timeout.`
      : "Fleet could not prove complete admission after the response timeout. Run status; do not repeat start.";
  }
  if (command === "export") {
    return payload.written
      ? `Support bundle written to ${payload.destination}.`
      : `Support bundle preview ready for ${payload.destination}.`;
  }
  return JSON.stringify(payload);
}

export async function runCli(argv, options = {}) {
  const io = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    home: options.home ?? os.homedir(),
    readStdin: options.readStdin,
    stdout: options.stdout ?? ((text) => process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => process.stderr.write(text)),
    isTTY: options.isTTY ?? process.stdout.isTTY === true
  };
  if (typeof io.readStdin !== "function") {
    io.readStdin = async () => Buffer.alloc(0);
  }

  let parsed;
  try {
    parsed = parseArguments(argv);
    const result = await execute(parsed, io, options.dependencies ?? {});
    const output = parsed.flags.has("--json")
      ? JSON.stringify(result.payload)
      : humanSummary(parsed.command, result.payload, parsed.flags);
    io.stdout(`${output}\n`);
    return result.exitCode;
  } catch (error) {
    const exitCode = error instanceof StartContractValidationError
      ? error.category === "invalidInput"
        ? EXIT_CODES.invalidInput
        : EXIT_CODES.authorityDenied
      : error instanceof CliError
        ? error.exitCode
        : EXIT_CODES.runtimeUnavailable;
    io.stderr(`${error.message}\n`);
    return exitCode;
  }
}
