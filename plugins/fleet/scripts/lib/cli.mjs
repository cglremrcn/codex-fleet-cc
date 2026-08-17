import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { normalizeAuthority } from "./authority.mjs";
import { runDoctor } from "./doctor.mjs";
import { getFleetDataDir, resolveOwnedPath, workspaceKey } from "./paths.mjs";
import { renderPlainStatus } from "./plain-status.mjs";
import { createRuntime } from "./runtime-adapter.mjs";
import { readWorkspaceState, writeWorkspaceState } from "./safe-state.mjs";
import { createScheduler } from "./scheduler.mjs";
import { previewSupportBundle, writeSupportBundle } from "./support-bundle.mjs";

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
  "start",
  "status",
  "result",
  "follow-up",
  "cancel",
  "export",
  "setup",
  "uninstall"
]);
const BOOLEAN_FLAGS = new Set(["--json", "--stdin", "--confirm"]);
const VALUE_FLAGS = new Set([
  "--contract",
  "--workspace",
  "--lane",
  "--output",
  "--confirm-token"
]);
const STRUCTURED_COMMANDS = new Set(["start", "follow-up", "cancel"]);
const COMMAND_FLAGS = Object.freeze({
  doctor: new Set(["--json", "--workspace"]),
  start: new Set(["--json", "--stdin", "--contract"]),
  status: new Set(["--json", "--workspace"]),
  result: new Set(["--json", "--workspace", "--lane"]),
  "follow-up": new Set(["--json", "--stdin", "--contract"]),
  cancel: new Set(["--json", "--stdin", "--contract", "--confirm"]),
  export: new Set(["--json", "--workspace", "--output", "--confirm-token"]),
  setup: new Set(["--json", "--workspace", "--confirm-token"]),
  uninstall: new Set(["--json", "--workspace", "--confirm-token"])
});
const ROOT_START_PROPERTIES = new Set([
  "schemaVersion",
  "workspacePath",
  "lanes",
  "limits",
  "confirmationRef"
]);
const LANE_PROPERTIES = new Set([
  "id",
  "role",
  "label",
  "model",
  "effort",
  "prompt",
  "authority",
  "checkoutKey",
  "priority",
  "retryOf",
  "reconciliationRef"
]);
const AUTHORITY_PROPERTIES = new Set([
  "sandbox",
  "network",
  "browser",
  "process",
  "database",
  "externalEffects",
  "retry"
]);
const AUTHORITY_NESTED_PROPERTIES = Object.freeze({
  browser: new Set(["inspect", "mutate"]),
  process: new Set(["start", "stopOwned"]),
  database: new Set(["read", "write"]),
  externalEffects: new Set(["send", "payment", "deploy", "delete"])
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
    if (flags.has(token)) {
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
    flags.set(token, value);
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

function validateAuthorityShape(authority) {
  assertPlainObject(authority, "Lane authority");
  rejectUnknownProperties(authority, AUTHORITY_PROPERTIES, "authority");
  for (const [name, allowed] of Object.entries(AUTHORITY_NESTED_PROPERTIES)) {
    if (authority[name] === undefined) {
      continue;
    }
    assertPlainObject(authority[name], `authority.${name}`);
    rejectUnknownProperties(authority[name], allowed, `authority.${name}`);
  }
  try {
    return normalizeAuthority(authority);
  } catch (error) {
    throw new InvalidInputError(error.message);
  }
}

function validateLimits(limits) {
  if (limits === undefined) {
    return undefined;
  }
  assertPlainObject(limits, "Fleet limits");
  rejectUnknownProperties(
    limits,
    new Set(["maxActive", "maxWritersPerCheckout", "staggerMs"]),
    "limits"
  );
  return limits;
}

function requiredConfirmationActions(authority) {
  const actions = [];
  if (authority.sandbox === "workspace-write") {
    actions.push("filesystem.write");
  }
  if (authority.browser.mutate) {
    actions.push("browser.submit");
  }
  const externalMapping = {
    send: "send.message",
    payment: "payment.execute",
    deploy: "deploy.production",
    delete: "delete.resource"
  };
  for (const [capability, action] of Object.entries(externalMapping)) {
    if (authority.externalEffects[capability]) {
      actions.push(action);
    }
  }
  return actions;
}

function validateStartContract(value) {
  assertPlainObject(value, "Start contract");
  rejectUnknownProperties(value, ROOT_START_PROPERTIES, "contract");
  if (value.schemaVersion !== 1) {
    throw new InvalidInputError("Start contract schemaVersion must be 1.");
  }
  const workspacePath = path.resolve(
    boundedText(value.workspacePath, "workspacePath", 4096)
  );
  if (!Array.isArray(value.lanes) || value.lanes.length === 0 || value.lanes.length > 256) {
    throw new InvalidInputError("Start contract must contain between 1 and 256 lanes.");
  }
  const confirmationRef = value.confirmationRef === undefined
    ? null
    : boundedText(value.confirmationRef, "confirmationRef", 512);

  const lanes = value.lanes.map((lane, index) => {
    assertPlainObject(lane, `Lane ${index + 1}`);
    rejectUnknownProperties(lane, LANE_PROPERTIES, "lane");
    boundedText(lane.prompt, `Lane ${index + 1} prompt`, MAX_CONTRACT_BYTES);
    const authority = validateAuthorityShape(lane.authority);
    if (!authority.process.start) {
      throw new AuthorityDeniedError(
        `Lane ${lane.id ?? index + 1} lacks process start authority.`
      );
    }
    const actions = requiredConfirmationActions(authority);
    if (actions.length > 0 && !confirmationRef) {
      throw new AuthorityDeniedError(
        `Lane ${lane.id ?? index + 1} requires a confirmation reference for: `
        + `${actions.join(", ")}.`
      );
    }
    return { ...lane, authority };
  });

  return {
    schemaVersion: 1,
    workspacePath,
    lanes,
    limits: validateLimits(value.limits),
    confirmationRef
  };
}

function validateSimpleContract(value, command, confirmed) {
  const allowed = command === "follow-up"
    ? new Set(["schemaVersion", "workspacePath", "laneId", "message"])
    : new Set(["schemaVersion", "workspacePath", "laneId"]);
  assertPlainObject(value, `${command} contract`);
  rejectUnknownProperties(value, allowed, "contract");
  if (value.schemaVersion !== 1) {
    throw new InvalidInputError(`${command} contract schemaVersion must be 1.`);
  }
  if (command === "cancel" && !confirmed) {
    throw new AuthorityDeniedError("Cancellation requires explicit --confirm authority.");
  }
  return {
    schemaVersion: 1,
    workspacePath: path.resolve(boundedText(value.workspacePath, "workspacePath", 4096)),
    laneId: boundedText(value.laneId, "laneId", 64),
    message: command === "follow-up"
      ? boundedText(value.message, "message", MAX_CONTRACT_BYTES)
      : null
  };
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

function serializedStateStore(root) {
  let writes = Promise.resolve();
  return {
    write(snapshot) {
      const state = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        lanes: [...snapshot.queued, ...snapshot.active, ...snapshot.history]
      };
      writes = writes.then(() => writeWorkspaceState(root, state));
      return writes;
    }
  };
}

async function runStart(contract, io, dependencies) {
  const context = await stateContext(contract.workspacePath, io);
  const runtimeFactory = dependencies.createRuntime ?? createRuntime;
  const runtime = await runtimeFactory({ cwd: context.workspace, env: io.env });
  const scheduler = createScheduler({
    runtime,
    store: serializedStateStore(context.root),
    limits: contract.limits
  });

  try {
    const admissions = contract.lanes.map((lane) => scheduler.enqueue({
      ...lane,
      workspacePath: context.workspace,
      workspaceKey: context.key,
      checkoutKey: lane.checkoutKey ?? context.key
    }));
    while (true) {
      await scheduler.reconcile();
      const snapshot = scheduler.snapshot();
      if (snapshot.queued.length === 0 && snapshot.active.length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await Promise.all(admissions);
    const snapshot = scheduler.snapshot();
    const unknown = snapshot.history.some((lane) => lane.status === "outcome_unknown");
    return {
      exitCode: unknown ? EXIT_CODES.outcomeUnknown : EXIT_CODES.success,
      payload: {
        schemaVersion: 1,
        workspaceKey: context.key,
        lanes: snapshot.history
      }
    };
  } finally {
    await runtime.close();
  }
}

async function execute(parsed, io, dependencies) {
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
    const state = await readStateWithoutCreating(context.root);
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
    }
    const unknown = lanes.some((lane) => lane.status === "outcome_unknown");
    return {
      exitCode: unknown ? EXIT_CODES.outcomeUnknown : EXIT_CODES.success,
      payload: {
        schemaVersion: 1,
        workspaceKey: context.key,
        workspace: { name: path.basename(context.workspace), branch: "unknown" },
        runtime: { health: "unknown", protocol: "unknown" },
        updatedAt: state.updatedAt,
        lanes
      }
    };
  }

  if (parsed.command === "start") {
    const raw = await readContract(parsed, io);
    return runStart(validateStartContract(raw), io, dependencies);
  }

  if (parsed.command === "follow-up" || parsed.command === "cancel") {
    const raw = await readContract(parsed, io);
    validateSimpleContract(raw, parsed.command, parsed.flags.has("--confirm"));
    throw new RuntimeUnavailableError(
      `${parsed.command} requires a live Fleet supervisor; supervisor control is not available.`
    );
  }

  if (parsed.command === "setup" || parsed.command === "uninstall") {
    throw new RuntimeUnavailableError(
      `${parsed.command} is provided by the reversible editor setup layer, which is not installed.`
    );
  }

  throw new InvalidInputError(`Unsupported command: ${parsed.command}.`);
}

function humanSummary(command, payload) {
  if (command === "doctor") {
    return `Fleet doctor: ${payload.overall}.`;
  }
  if (command === "status") {
    return renderPlainStatus(payload).trimEnd();
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
      : humanSummary(parsed.command, result.payload);
    io.stdout(`${output}\n`);
    return result.exitCode;
  } catch (error) {
    const exitCode = error instanceof CliError
      ? error.exitCode
      : EXIT_CODES.runtimeUnavailable;
    io.stderr(`${error.message}\n`);
    return exitCode;
  }
}
