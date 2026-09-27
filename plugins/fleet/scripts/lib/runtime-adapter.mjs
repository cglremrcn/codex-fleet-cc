import { InterventionInbox } from "./intervention-inbox.mjs";
import { discoverNativeThreads } from "./fleet-inventory.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { discoverModels } from "./model-catalog.mjs";
import { normalizeTokenUsage, usageFromNotification } from "./token-usage.mjs";

import {
  BROKER_PROTOCOL_VERSION,
  createAppServerBroker
} from "../app-server-broker.mjs";
import { normalizeAuthority } from "./authority.mjs";
import { createLane } from "./domain.mjs";
import {
  LANE_OUTCOME_SCHEMA,
  MAX_AUTOMATIC_CONTINUATIONS,
  buildDeveloperInstructions,
  buildExecutionPrompt,
  decideLaneOutcome
} from "./lane-outcome.mjs";
import { redactText } from "./redaction.mjs";

const MAX_PROMPT_LENGTH = 128 * 1024;
const MAX_TRANSCRIPT_ITEMS = 96;
const MAX_TRANSCRIPT_ITEM_LENGTH = 4_096;
const MAX_TRANSCRIPT_TURNS = 24;
const MAX_PREFLIGHT_OUTPUT = 16 * 1024;
const REPORT_REPAIR_LIMIT = 1;
const IGNORED_NOTIFICATION_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta"
]);

function defaultVerifyCommitRef(workspacePath, sha) {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd: workspacePath,
    shell: false,
    timeout: 2_000,
    maxBuffer: 65_536,
    windowsHide: true
  });
  return result.status === 0 && result.error === undefined;
}

function commitDiagnostic(unverified) {
  return Object.freeze({
    code: "invalid_lane_outcome",
    missing: Object.freeze([]),
    unknown: Object.freeze([]),
    invalid: Object.freeze(unverified.map((sha) => `commitRefs:${sha}`))
  });
}

function needsImageSkill(authority) {
  return authority?.image?.generate === true || authority?.image?.edit === true;
}

export function sandboxPolicyForLane(lane) {
  if (!lane || typeof lane !== "object" || !path.isAbsolute(lane.workspacePath ?? "")) {
    throw new TypeError("Lane sandbox policy requires an absolute workspace path.");
  }
  if (lane.authority?.sandbox === "workspace-write") {
    return Object.freeze({
      type: "workspaceWrite",
      writableRoots: Object.freeze([path.resolve(lane.workspacePath)]),
      networkAccess: lane.authority.network === "live"
    });
  }
  return Object.freeze({
    type: "readOnly",
    access: Object.freeze({ type: "fullAccess" }),
    networkAccess: false
  });
}

function isInsideWorkspace(workspacePath, candidate) {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function workspaceRelativePath(workspacePath, candidate) {
  if (typeof candidate !== "string" || !candidate || /[\u0000-\u001f\u007f]/u.test(candidate)) return null;
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspacePath, candidate);
  if (!isInsideWorkspace(workspacePath, absolute)) return null;
  const relative = path.relative(path.resolve(workspacePath), absolute).replaceAll(path.sep, "/");
  return relative && relative.length <= 512 ? relative : null;
}

function recordTouchedFiles(lane, item) {
  if (item?.type !== "fileChange" || !Array.isArray(item.changes)) return;
  lane.touchedFiles ??= new Set();
  for (const change of item.changes) {
    const relative = workspaceRelativePath(lane.workspacePath, change?.path);
    if (relative) lane.touchedFiles.add(relative);
    if (lane.touchedFiles.size >= 128) break;
  }
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function safePreflightText(value, maximum = 1_000) {
  return redactText(String(value ?? "")).slice(0, maximum);
}

function preflightFailure(check, response, lane) {
  const stderr = safePreflightText(response?.stderr ?? "");
  const stdout = safePreflightText(response?.stdout ?? "");
  const details = stderr || stdout || `exit ${String(response?.exitCode ?? "unknown")}`;
  const windowsHint = process.platform === "win32" && /EPERM|access is denied|permission/iu.test(details)
    ? " On Windows, verify the Codex `[windows] sandbox = \"elevated\"` configuration or choose controller-owned verification; Fleet did not spend a model turn."
    : "";
  return Object.freeze({
    ok: false,
    status: "blocked",
    check,
    reason: `${check} preflight failed: ${details}.${windowsHint}`.slice(0, 2_000),
    modelTurnStarted: false,
    workspace: path.basename(lane.workspacePath)
  });
}

function preflightPass(check, details = null) {
  return Object.freeze({ ok: true, status: "passed", check, details, modelTurnStarted: false });
}

function preflightWarning(check, details) {
  return Object.freeze({ ok: true, status: "warning", check, details, modelTurnStarted: false });
}

function imageSkillCandidates(response) {
  const groups = Array.isArray(response?.data) ? response.data : [];
  return groups.flatMap((group) => Array.isArray(group?.skills) ? group.skills : []);
}

function validateImageSkill(response) {
  const skill = imageSkillCandidates(response).find((candidate) => (
    candidate?.name === "imagegen"
    && candidate?.enabled === true
    && candidate?.scope === "system"
  ));
  const skillPath = skill?.path;
  if (
    !skill
    || typeof skillPath !== "string"
    || !path.isAbsolute(skillPath)
    || path.basename(skillPath).toLowerCase() !== "skill.md"
  ) {
    throw new Error(
      "Image capability blocked: the enabled imagegen skill is unavailable or malformed. "
      + "Fleet did not start the Codex turn and did not substitute another generator."
    );
  }
  return Object.freeze({ type: "skill", name: "imagegen", path: path.resolve(skillPath) });
}

function assertPrompt(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PROMPT_LENGTH) {
    throw new TypeError(`${label} must contain between 1 and ${MAX_PROMPT_LENGTH} characters.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${label} cannot contain null bytes.`);
  }
  return value;
}

function assertRuntimeId(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must contain between 1 and 256 safe characters.`);
  }
  return value;
}

function isAcceptanceUnknown(error) {
  return error?.requestAcceptance === "unknown";
}

function runtimeBlocker(error) {
  const message = redactText(error?.message ?? "Codex turn acceptance is unknown.");
  return {
    exitReason: message,
    controllerRequest: Object.freeze({
      kind: "runtime_blocker",
      question: message
    }),
    stopReason: message
  };
}

export function turnFailureReason(turn) {
  const status = typeof turn?.status === "string" && turn.status
    ? turn.status
    : "failed";
  const message = typeof turn?.error?.message === "string"
    ? turn.error.message.trim()
    : "";
  return redactText(message || status).slice(0, 2_000);
}

function copyLane(lane) {
  return Object.freeze({
    id: lane.id,
    role: lane.role,
    label: lane.label,
    workspaceKey: lane.workspaceKey,
    ...(lane.groupPath === undefined ? {} : { groupPath: lane.groupPath }),
    ...(lane.tokenUsage ? { tokenUsage: normalizeTokenUsage(lane.tokenUsage) } : {}),
    model: lane.model,
    effort: lane.effort,
    authority: lane.authority,
    status: lane.status,
    phase: lane.phase,
    interactive: lane.interactive === true,
    pendingRequests: lane.pendingRequests ?? 0,
    pendingQuestionCount: lane.pendingQuestionCount ?? 0,
    pendingApprovalCount: lane.pendingApprovalCount ?? 0,
    createdAt: lane.createdAt,
    updatedAt: lane.updatedAt,
    threadId: lane.threadId,
    turnId: lane.turnId,
    lastMessage: lane.lastMessage,
    exitReason: lane.exitReason,
    outcome: lane.outcome,
    workPerformed: lane.workPerformed,
    evidenceRefs: lane.evidenceRefs,
    verification: lane.verification,
    verificationResults: lane.verificationResults,
    artifactRefs: lane.artifactRefs,
    commitRefs: lane.commitRefs,
    configChanges: lane.configChanges,
    outcomeDiagnostics: lane.outcomeDiagnostics,
    controllerRequest: lane.controllerRequest,
    stopReason: lane.stopReason,
    automaticContinuations: lane.automaticContinuations,
    reportRepairAttempts: lane.reportRepairAttempts ?? 0,
    preflight: lane.preflight ?? null,
    touchedFiles: Object.freeze([...(lane.touchedFiles ?? [])].slice(0, 128))
  });
}

function notificationThreadId(message) {
  return message?.params?.threadId ?? message?.params?.thread?.id ?? null;
}

function notificationTurnId(message) {
  return message?.params?.turnId ?? message?.params?.turn?.id ?? null;
}

function safeItemPayload(item) {
  if (!item || typeof item !== "object") {
    return {};
  }
  switch (item.type) {
    case "agentMessage":
      return { text: redactText(item.text ?? ""), phase: item.phase ?? null };
    case "commandExecution":
      return { command: redactText(item.command ?? ""), status: item.status ?? null };
    case "fileChange":
      return { count: Array.isArray(item.changes) ? item.changes.length : 0 };
    case "mcpToolCall":
      return { server: redactText(item.server ?? ""), tool: redactText(item.tool ?? "") };
    case "webSearch":
      return { query: redactText(item.query ?? "") };
    default:
      return { itemType: redactText(item.type ?? "unknown") };
  }
}

function transcriptText(value) {
  return redactText(value ?? "").slice(0, MAX_TRANSCRIPT_ITEM_LENGTH);
}

function userInputText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (item?.type === "text") return item.text ?? "";
    if (item?.type === "image" || item?.type === "localImage") return "[image attached]";
    if (item?.type === "audio" || item?.type === "localAudio") return "[audio attached]";
    if (item?.type === "skill") return `[skill: ${item.name ?? "unknown"}]`;
    if (item?.type === "mention") return `[mention: ${item.name ?? "unknown"}]`;
    return "[attachment]";
  }).filter(Boolean).join("\n");
}

function transcriptItem(item, turnId) {
  if (!item || typeof item !== "object") return null;
  const base = { turnId, itemId: typeof item.id === "string" ? item.id : null };
  switch (item.type) {
    case "userMessage":
      return { ...base, kind: "user", text: transcriptText(userInputText(item.content)) };
    case "agentMessage":
      return { ...base, kind: "assistant", text: transcriptText(item.text) };
    case "plan":
      return { ...base, kind: "assistant", text: transcriptText(`[plan]\n${item.text ?? ""}`) };
    case "commandExecution":
      return {
        ...base,
        kind: "activity",
        // Command text can contain credentials or private paths. The embedded
        // session shows lifecycle truth without replaying raw shell input/output.
        text: transcriptText(`COMMAND ${String(item.status ?? "unknown").toUpperCase()}`)
      };
    case "fileChange":
      return {
        ...base,
        kind: "activity",
        text: `FILE CHANGE ${String(item.status ?? "unknown").toUpperCase()} · ${Array.isArray(item.changes) ? item.changes.length : 0} change(s)`
      };
    case "mcpToolCall":
      return {
        ...base,
        kind: "activity",
        text: transcriptText(`MCP ${item.server ?? "unknown"}/${item.tool ?? "unknown"} · ${item.status ?? "unknown"}`)
      };
    case "dynamicToolCall":
      return {
        ...base,
        kind: "activity",
        text: transcriptText(`TOOL ${item.namespace ? `${item.namespace}/` : ""}${item.tool ?? "unknown"} · ${item.status ?? "unknown"}`)
      };
    case "webSearch":
      return { ...base, kind: "activity", text: transcriptText(`WEB SEARCH · ${item.query ?? ""}`) };
    case "imageGeneration":
      return { ...base, kind: "activity", text: transcriptText(`IMAGE GENERATION · ${item.status ?? "unknown"}`) };
    case "imageView":
      return { ...base, kind: "activity", text: "IMAGE VIEW" };
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "activity",
        text: transcriptText(`AGENT ${item.tool ?? "control"} · ${item.status ?? "unknown"}`)
      };
    case "reasoning":
    case "hookPrompt":
      return null;
    default:
      return { ...base, kind: "activity", text: transcriptText(String(item.type ?? "activity")) };
  }
}

function sessionSource(value) {
  if (typeof value === "string") return transcriptText(value);
  if (value && typeof value === "object") {
    return transcriptText(value.type ?? value.kind ?? "app-server");
  }
  return "app-server";
}

function safeThreadSession(thread) {
  const messages = [];
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const safe = transcriptItem(item, typeof turn?.id === "string" ? turn.id : null);
      if (safe?.text) messages.push(safe);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    threadId: assertRuntimeId(thread?.id, "Codex thread id"),
    sessionId: typeof thread?.sessionId === "string" ? transcriptText(thread.sessionId) : null,
    parentThreadId: typeof thread?.parentThreadId === "string"
      ? transcriptText(thread.parentThreadId)
      : null,
    source: sessionSource(thread?.source),
    name: typeof thread?.name === "string" ? transcriptText(thread.name) : null,
    status: typeof thread?.status === "string"
      ? transcriptText(thread.status)
      : transcriptText(thread?.status?.type ?? "unknown"),
    canAcceptDirectInput: thread?.canAcceptDirectInput === true,
    createdAt: Number.isFinite(thread?.createdAt) ? thread.createdAt : null,
    updatedAt: Number.isFinite(thread?.updatedAt) ? thread.updatedAt : null,
    messages: Object.freeze(messages.slice(-MAX_TRANSCRIPT_ITEMS).map((message) => Object.freeze(message)))
  });
}

export class FleetRuntime {
  constructor(broker, options = {}) {
    this.broker = broker;
    this.options = options;
    this.lanes = new Map();
    this.threadToLane = new Map();
    this.turnToLane = new Map();
    this.pendingNotifications = new Map();
    this.pendingTurnNotifications = new Map();
    this.nextSequence = 1;
    this.closed = false;
    this.verifyCommitRef = options.verifyCommitRef ?? defaultVerifyCommitRef;
    this.connectedProtocolVersion = options.brokerProtocolVersion
      ?? broker.protocolVersion;
    this.inbox = new InterventionInbox({
      send: (id, envelope) => broker.replyToServer(id, envelope),
      isCurrent: (entry) => {
        const lane = this.lanes.get(entry.laneId);
        return !this.closed && !broker.exited && lane?.threadId === entry.threadId && lane?.turnId === entry.turnId && ["starting", "running"].includes(lane.status);
      },
      onChange: (id) => this.updatePendingRequests(id)
    });
    broker.setServerRequestHandler?.((message) => {
      this.assertMutableProtocol();
      const lane = this.lanes.get(this.threadToLane.get(message.params?.threadId));
      if (!lane) return false;
      // A request can precede its turn/start acknowledgement, but never revive a retired turn.
      const turnId = message.params?.turnId;
      if (!lane.turnId && !lane.retiredTurnIds?.has(turnId) && lane.status === "running") {
        try {
          this.inbox.validate(message, { ...lane, turnId });
          this.bindTurn(lane, turnId);
        } catch { return false; }
      }
      try { this.inbox.receive(message, lane); return true; }
      catch (error) {
        if (error.code === "FLEET_INBOX_COLLISION") {
          this.inbox.disconnect(); void broker.close().catch(() => undefined); return true;
        }
        this.emit(lane.id, "intervention.rejected", { reason: "unsupported-or-invalid-request" });
        return false;
      }
    });
    broker.setEventHandler((message) => this.handleNotification(message));
  }

  updatePendingRequests(id) {
    const lane = this.lanes.get(id);
    if (!lane) return;
    const requests = [...this.inbox.entries.values()].filter((entry) => entry.laneId === id && ["pending", "delegated", "sending", "sent"].includes(entry.state));
    lane.pendingRequests = requests.length;
    lane.pendingQuestionCount = requests.filter((entry) => entry.kind === "question").length;
    lane.pendingApprovalCount = requests.filter((entry) => entry.kind === "approval").length;
    this.emit(id, "intervention.changed", { pendingRequests: lane.pendingRequests });
  }

  assertMutableProtocol() {
    if (this.connectedProtocolVersion !== BROKER_PROTOCOL_VERSION) {
      throw new Error(
        `Broker protocol version mismatch: expected ${BROKER_PROTOCOL_VERSION}, `
        + `received ${this.connectedProtocolVersion}. Runtime mutations are blocked.`
      );
    }
    if (this.closed) {
      throw new Error("Fleet runtime is closed.");
    }
  }

  verifyReportedCommits(lane, result) {
    const verified = [];
    const unverified = [];
    for (const sha of result.commitRefs) {
      let valid = false;
      try {
        valid = this.verifyCommitRef(lane.workspacePath, sha) === true;
      } catch {
        valid = false;
      }
      (valid ? verified : unverified).push(sha);
    }
    return Object.freeze({
      verified: Object.freeze(verified),
      unverified: Object.freeze(unverified)
    });
  }

  async listModels() {
    if (!this.modelCatalogue || Date.now() - this.modelCatalogue.at >= 60_000) {
      // Shared promise coalesces simultaneous admissions without guessing unavailable models.
      if (!this.modelDiscovery) this.modelDiscovery = discoverModels(
        (method, params) => this.broker.request(method, params)
      ).then((models) => {
        this.modelCatalogue = { at: Date.now(), models };
        return models;
      }).finally(() => { this.modelDiscovery = null; });
      return this.modelDiscovery;
    }
    return this.modelCatalogue.models;
  }

  modelCatalogInfo() {
    const discoveredAt = this.modelCatalogue?.at ?? null;
    return Object.freeze({
      source: "connected-codex-runtime",
      discoveredAt: discoveredAt === null ? null : new Date(discoveredAt).toISOString(),
      ageMs: discoveredAt === null ? null : Math.max(0, Date.now() - discoveredAt),
      models: Object.freeze([...(this.modelCatalogue?.models ?? [])])
    });
  }

  async refreshModels() {
    this.modelCatalogue = null;
    return this.listModels();
  }

  async commandPreflight(lane, command, options = {}) {
    let response;
    try {
      response = await this.broker.request("command/exec", {
        command,
        cwd: lane.workspacePath,
        timeoutMs: options.timeoutMs ?? 5_000,
        outputBytesCap: options.outputBytesCap ?? MAX_PREFLIGHT_OUTPUT,
        sandboxPolicy: options.sandboxPolicy ?? sandboxPolicyForLane(lane),
        ...(options.env ? { env: options.env } : {})
      }, { timeoutMs: (options.timeoutMs ?? 5_000) + 2_000 });
    } catch (error) {
      if (error?.rpcCode === -32601 || /unknown (?:method|variant)|not implemented/iu.test(error?.message ?? "")) {
        return preflightWarning(options.check ?? "process", "Codex command/exec preflight is unavailable in this runtime; admission continues without claiming the process gate was proven.");
      }
      return Object.freeze({
        ok: false,
        status: "blocked",
        check: options.check ?? "process",
        reason: `Preflight transport failed before any model turn: ${safePreflightText(error?.message ?? error)}`,
        modelTurnStarted: false
      });
    }
    if (response?.exitCode !== 0) return preflightFailure(options.check ?? "process", response, lane);
    return preflightPass(options.check ?? "process", safePreflightText(response.stdout ?? "", 2_000));
  }

  async inspectPythonEnvironment(lane) {
    const pyproject = path.join(lane.workspacePath, "pyproject.toml");
    if (!await exists(pyproject)) return null;
    const candidates = process.platform === "win32"
      ? [path.join(lane.workspacePath, ".venv", "Scripts", "python.exe")]
      : [path.join(lane.workspacePath, ".venv", "bin", "python")];
    const interpreter = (await Promise.all(candidates.map(async (candidate) => (
      await exists(candidate) ? candidate : null
    )))).find(Boolean);
    if (!interpreter) {
      const hasUvLock = await exists(path.join(lane.workspacePath, "uv.lock"));
      return preflightWarning(
        "python-environment",
        hasUvLock
          ? "pyproject.toml and uv.lock exist but this worktree has no local .venv. Fleet will not guess that a shared/editable environment belongs to this worktree."
          : "pyproject.toml exists but this worktree has no local .venv; Python provenance was not proven."
      );
    }
    const script = [
      "import importlib.metadata as m, json, pathlib, sys, urllib.parse, urllib.request",
      "roots=[]",
      "for d in m.distributions():",
      "  try:",
      "    raw=d.read_text('direct_url.json')",
      "    if not raw: continue",
      "    obj=json.loads(raw)",
      "    if not obj.get('dir_info',{}).get('editable'): continue",
      "    url=obj.get('url','')",
      "    if url.startswith('file:'):",
      "      p=urllib.request.url2pathname(urllib.parse.urlparse(url).path)",
      "      roots.append(str(pathlib.Path(p).resolve()))",
      "  except Exception: pass",
      "print(json.dumps({'executable':sys.executable,'prefix':sys.prefix,'editableRoots':sorted(set(roots))}))"
    ].join("\n");
    const result = await this.commandPreflight(lane, [interpreter, "-c", script], {
      check: "python-environment",
      timeoutMs: 8_000
    });
    if (!result.ok || result.status === "warning") return result;
    let payload;
    try {
      payload = JSON.parse(result.details);
    } catch {
      return preflightWarning("python-environment", "The local .venv ran, but its provenance response could not be decoded.");
    }
    const outside = (payload.editableRoots ?? []).filter((candidate) => (
      typeof candidate === "string" && path.isAbsolute(candidate) && !isInsideWorkspace(lane.workspacePath, candidate)
    ));
    if (outside.length > 0) {
      return Object.freeze({
        ok: false,
        status: "blocked",
        check: "python-environment",
        reason: "The worktree's local Python environment resolves one or more editable distributions outside this workspace. Tests could pass against a different worktree, so Fleet refused to spend a model turn.",
        modelTurnStarted: false,
        externalEditableCount: outside.length
      });
    }
    return preflightPass("python-environment", "Local .venv provenance is rooted in this workspace.");
  }

  async preflightLane(lane) {
    const checks = [];
    if (lane.authority?.sandbox === "workspace-write") {
      const nestedProcessScript = [
        "const {spawnSync}=require('node:child_process');",
        "const r=spawnSync(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});",
        "if(r.error){console.error(r.error.code||r.error.message);process.exit(91)}",
        "process.exit(r.status??92);"
      ].join("");
      checks.push(await this.commandPreflight(lane, [process.execPath, "-e", nestedProcessScript], {
        check: "nested-process"
      }));
      if (checks.at(-1)?.ok === false) return Object.freeze({ ok: false, checks: Object.freeze(checks) });
    }
    const python = await this.inspectPythonEnvironment(lane);
    if (python) {
      checks.push(python);
      if (python.ok === false) return Object.freeze({ ok: false, checks: Object.freeze(checks) });
    }
    return Object.freeze({ ok: true, checks: Object.freeze(checks) });
  }

  async prepareSkillInputs(lane) {
    if (!needsImageSkill(lane.authority)) {
      lane.skillInputs = Object.freeze([]);
      return;
    }
    const response = await this.broker.request("skills/list", {
      cwds: [lane.workspacePath],
      forceReload: true
    });
    lane.skillInputs = Object.freeze([validateImageSkill(response)]);
  }

  turnInput(lane, text) {
    return [
      { type: "text", text, text_elements: [] },
      ...(lane.skillInputs ?? [])
    ];
  }

  emit(laneId, type, payload = {}) {
    const event = Object.freeze({
      laneId,
      sequence: this.nextSequence,
      at: new Date().toISOString(),
      type,
      payload: Object.freeze(payload)
    });
    this.nextSequence += 1;
    try {
      this.options.onEvent?.(event);
    } catch {
      // Observers cannot break the runtime state machine.
    }
    return event;
  }

  updateLane(lane, patch, eventType, payload = {}) {
    Object.assign(lane, patch, { updatedAt: new Date().toISOString() });
    this.emit(lane.id, eventType, payload);
  }

  bindThread(lane, threadId) {
    lane.threadId = threadId;
    this.threadToLane.set(threadId, lane.id);
    const buffered = this.pendingNotifications.get(threadId) ?? [];
    this.pendingNotifications.delete(threadId);
    for (const message of buffered) {
      this.applyNotification(lane, message);
    }
  }

  unbindTurn(lane) {
    if (lane.turnId) {
      lane.retiredTurnIds ??= new Set();
      lane.retiredTurnIds.add(lane.turnId);
      if (lane.retiredTurnIds.size > 256) lane.retiredTurnIds.delete(lane.retiredTurnIds.values().next().value);
    }
    if (lane.turnId && this.turnToLane.get(lane.turnId) === lane.id) {
      this.turnToLane.delete(lane.turnId);
    }
    lane.turnId = null;
    lane.interventionItems?.clear();
  }

  bindTurn(lane, turnId) {
    const validated = assertRuntimeId(turnId, "Codex turn id");
    if (lane.turnId !== validated) this.unbindTurn(lane);
    lane.retiredTurnIds?.delete(validated); // An acknowledged turn/start response is authoritative.
    lane.turnId = validated;
    this.turnToLane.set(validated, lane.id);
    const buffered = this.pendingTurnNotifications.get(validated) ?? [];
    this.pendingTurnNotifications.delete(validated);
    for (const message of buffered) {
      this.applyNotification(lane, message);
    }
  }

  async dispatchTurn(lane, params) {
    const dispatch = Symbol("turn dispatch");
    lane.turnDispatch = dispatch;
    try {
      const response = await this.broker.request("turn/start", params);
      // Notifications can complete this turn and dispatch recovery before its reply arrives.
      if (lane.turnDispatch === dispatch && response.turn?.id) {
        this.bindTurn(lane, response.turn.id);
      }
    } catch (error) {
      if (lane.turnDispatch === dispatch) throw error;
    }
  }

  handleNotification(message) {
    if (message.method === "fleet/brokerClosed") { this.inbox.disconnect(); return; }
    if (message.method === "serverRequest/resolved") {
      this.inbox.resolved(message.params?.threadId, message.params?.requestId); return;
    }
    if (IGNORED_NOTIFICATION_METHODS.has(message.method)) {
      return;
    }
    const threadId = notificationThreadId(message);
    const turnId = notificationTurnId(message);
    const laneId = threadId
      ? this.threadToLane.get(threadId)
      : turnId ? this.turnToLane.get(turnId) : null;
    if (!laneId) {
      const pending = threadId
        ? this.pendingNotifications.get(threadId) ?? []
        : turnId ? this.pendingTurnNotifications.get(turnId) ?? [] : [];
      if (pending.length < 64) {
        pending.push(message);
        if (threadId) this.pendingNotifications.set(threadId, pending);
        else if (turnId) this.pendingTurnNotifications.set(turnId, pending);
      }
      return;
    }
    const lane = this.lanes.get(laneId);
    if (lane) {
      this.applyNotification(lane, message);
    }
  }

  applyNotification(lane, message) {
    if (message.method === "thread/tokenUsage/updated") {
      const reported = usageFromNotification(message.params?.tokenUsage);
      if (reported && (lane.tokenUsage?.total === undefined || reported.total === undefined
        || reported.total >= lane.tokenUsage.total)) {
        // total is cumulative. Replace snapshots; adding replays would double-count.
        lane.tokenUsage = reported;
        this.emit(lane.id, "usage.updated", { tokenUsage: reported });
      }
      return;
    }
    const turnId = notificationTurnId(message);
    if (turnId && (lane.retiredTurnIds?.has(turnId) || (lane.turnId && lane.turnId !== turnId))) {
      return; // Delayed events cannot replace the current owned turn or revive a retired one.
    }
    if (turnId && lane.turnId !== turnId) {
      // A thread-scoped item may establish ownership before turn/start responds.
      // Replay earlier turn-only events now, not after a later terminal event.
      this.bindTurn(lane, turnId);
    }

    switch (message.method) {
      case "thread/started":
        this.emit(lane.id, "thread.started", { threadId: lane.threadId });
        break;
      case "turn/started":
        this.updateLane(
          lane,
          {
            status: "running",
            phase: lane.phase.startsWith("recovering ") ? lane.phase : "running"
          },
          "turn.started",
          { threadId: lane.threadId, turnId: lane.turnId }
        );
        break;
      case "item/started":
      case "item/completed": {
        const item = message.params?.item;
        recordTouchedFiles(lane, item);
        if (item?.type === "fileChange" && typeof item.id === "string" && message.method === "item/started") {
          lane.interventionItems ??= new Map();
          if (Array.isArray(item.changes) && item.changes.length <= 64 && Buffer.byteLength(JSON.stringify(item.changes)) <= 32 * 1024) {
            if (lane.interventionItems.size >= 64) lane.interventionItems.delete(lane.interventionItems.keys().next().value);
            lane.interventionItems.set(item.id, structuredClone(item.changes));
          }
        }
        if (item?.type === "reasoning") {
          return;
        }
        if (item?.type === "agentMessage" && message.method === "item/completed") {
          lane.lastMessage = redactText(item.text ?? "");
        }
        this.emit(
          lane.id,
          message.method === "item/started" ? "item.started" : "item.completed",
          safeItemPayload(item)
        );
        break;
      }
      case "error":
        this.updateLane(
          lane,
          {
            status: "failed",
            phase: "failed",
            exitReason: redactText(message.params?.error?.message ?? "Codex runtime error")
          },
          "turn.failed",
          { message: lane.exitReason }
        );
        break;
      case "turn/completed": {
        this.inbox.invalidateTurn(lane.threadId, lane.turnId);
        lane.interventionItems?.clear();
        const turnStatus = message.params?.turn?.status;
        if (turnStatus === "completed") {
          const decision = decideLaneOutcome(
            lane.lastMessage ?? "",
            lane.automaticContinuations,
            {
              authority: lane.authority,
              reportRepairAttempts: lane.reportRepairAttempts ?? 0
            }
          );
          const commits = decision.result
            ? this.verifyReportedCommits(lane, decision.result)
            : Object.freeze({ verified: Object.freeze([]), unverified: Object.freeze([]) });
          if (commits.unverified.length > 0) {
            const result = decision.result;
            const question = redactText(
              `Reported commit ${commits.unverified.join(", ")} could not be verified in the admitted workspace.`
            );
            this.updateLane(
              lane,
              {
                status: "blocked",
                phase: "needs-controller",
                exitReason: question,
                outcome: result.outcome,
                lastMessage: result.summary,
                workPerformed: result.workPerformed,
                evidenceRefs: result.evidenceRefs,
                verification: result.verification,
                verificationResults: result.verificationResults,
                artifactRefs: result.artifactRefs,
                commitRefs: commits.verified,
                configChanges: result.configChanges,
                outcomeDiagnostics: commitDiagnostic(commits.unverified),
                controllerRequest: Object.freeze({ kind: "runtime_blocker", question }),
                stopReason: question
              },
              "turn.blocked",
              { threadId: lane.threadId, turnId: lane.turnId }
            );
            break;
          }
          if (decision.action === "complete") {
            const result = decision.result;
            this.updateLane(
              lane,
              {
                status: "complete",
                phase: "complete",
                exitReason: null,
                outcome: result.outcome,
                lastMessage: result.summary,
                workPerformed: result.workPerformed,
                evidenceRefs: result.evidenceRefs,
                verification: result.verification,
                verificationResults: result.verificationResults,
                artifactRefs: result.artifactRefs,
                commitRefs: commits.verified,
                configChanges: result.configChanges,
                outcomeDiagnostics: null,
                controllerRequest: null,
                stopReason: result.stopReason
              },
              "turn.complete",
              { threadId: lane.threadId, turnId: lane.turnId }
            );
          } else if (decision.action === "repair-report") {
            void this.beginReportRepair(lane, decision.prompt, decision.diagnostics);
          } else if (decision.action === "continue") {
            void this.beginAutomaticContinuation(lane, decision.prompt);
          } else if (decision.action === "outcome-unknown") {
            this.updateLane(
              lane,
              {
                status: "outcome_unknown",
                phase: "outcome_unknown",
                exitReason: redactText(decision.reason),
                outcome: decision.result?.outcome ?? null,
                workPerformed: decision.result?.workPerformed ?? Object.freeze([]),
                evidenceRefs: decision.result?.evidenceRefs ?? Object.freeze([]),
                verification: decision.result?.verification ?? Object.freeze([]),
                verificationResults: decision.result?.verificationResults ?? Object.freeze([]),
                artifactRefs: decision.result?.artifactRefs ?? Object.freeze([]),
                commitRefs: commits.verified,
                configChanges: decision.result?.configChanges ?? Object.freeze([]),
                outcomeDiagnostics: decision.diagnostics ?? null,
                controllerRequest: decision.result?.controllerRequest ?? null,
                stopReason: decision.result?.stopReason ?? redactText(decision.reason)
              },
              "turn.outcome-unknown",
              { threadId: lane.threadId, turnId: lane.turnId }
            );
          } else {
            const controllerRequest = decision.result?.controllerRequest ?? Object.freeze({
              kind: "runtime_blocker",
              question: redactText(decision.reason)
            });
            this.updateLane(
              lane,
              {
                status: "blocked",
                phase: "needs-controller",
                exitReason: redactText(decision.reason),
                outcome: decision.result?.outcome ?? null,
                workPerformed: decision.result?.workPerformed ?? Object.freeze([]),
                evidenceRefs: decision.result?.evidenceRefs ?? Object.freeze([]),
                verification: decision.result?.verification ?? Object.freeze([]),
                verificationResults: decision.result?.verificationResults ?? Object.freeze([]),
                artifactRefs: decision.result?.artifactRefs ?? Object.freeze([]),
                commitRefs: commits.verified,
                configChanges: decision.result?.configChanges ?? Object.freeze([]),
                outcomeDiagnostics: decision.diagnostics ?? null,
                controllerRequest,
                stopReason: decision.result?.stopReason ?? redactText(decision.reason)
              },
              "turn.blocked",
              { threadId: lane.threadId, turnId: lane.turnId }
            );
          }
          break;
        }
        const status = turnStatus === "interrupted" ? "cancelled" : "failed";
        this.updateLane(
          lane,
          {
            status,
            phase: status,
            exitReason: turnFailureReason(message.params?.turn)
          },
          `turn.${status}`,
          { threadId: lane.threadId, turnId: lane.turnId }
        );
        break;
      }
      default:
        break;
    }
  }

  async startLane(contract) {
    this.assertMutableProtocol();
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new TypeError("Lane runtime contract must be an object.");
    }
    if (!path.isAbsolute(contract.workspacePath ?? "")) {
      throw new TypeError("Lane workspacePath must be absolute.");
    }
    const prompt = assertPrompt(contract.prompt, "Lane prompt");
    if (this.lanes.has(contract.id)) {
      throw new Error(`Lane already exists: ${contract.id}.`);
    }

    const authority = normalizeAuthority(contract.authority);
    const validated = createLane({ ...contract, authority });
    const lane = {
      ...validated,
      authority,
      workspacePath: path.resolve(contract.workspacePath),
      ephemeral: contract.ephemeral === true,
      interactive: contract.interactive === true,
      threadId: null,
      turnId: null,
      lastMessage: null,
      exitReason: null,
      outcome: null,
      workPerformed: Object.freeze([]),
      evidenceRefs: Object.freeze([]),
      verification: Object.freeze([]),
      verificationResults: Object.freeze([]),
      artifactRefs: Object.freeze([]),
      commitRefs: Object.freeze([]),
      configChanges: Object.freeze([]),
      outcomeDiagnostics: null,
      controllerRequest: null,
      stopReason: null,
      automaticContinuations: 0,
      reportRepairAttempts: 0,
      verificationPlan: contract.verificationPlan ?? null,
      sharedContext: contract.sharedContext ?? null,
      preflight: null,
      skillInputs: Object.freeze([])
    };
    this.lanes.set(lane.id, lane);
    this.emit(lane.id, "lane.queued", {});

    try {
      lane.preflight = await this.preflightLane(lane);
      if (lane.preflight.ok === false) {
        const failed = lane.preflight.checks.find((check) => check.ok === false);
        const question = failed?.reason ?? "Fleet preflight failed before the first model turn.";
        this.updateLane(
          lane,
          {
            status: "blocked",
            phase: "preflight",
            exitReason: question,
            controllerRequest: Object.freeze({ kind: "runtime_blocker", question }),
            stopReason: question
          },
          "lane.preflight-blocked",
          { check: failed?.check ?? "unknown", modelTurnStarted: false }
        );
        return copyLane(lane);
      }
      await this.prepareSkillInputs(lane);
      const thread = await this.broker.request("thread/start", {
        cwd: lane.workspacePath,
        model: lane.model,
        approvalPolicy: lane.interactive === true ? "on-request" : "never",
        sandboxPolicy: sandboxPolicyForLane(lane),
        developerInstructions: buildDeveloperInstructions(lane.sharedContext),
        serviceName: "codex_fleet_cc",
        ephemeral: lane.ephemeral
      });
      this.bindThread(lane, thread.thread.id);
      if (!lane.ephemeral) {
        await this.broker.request("thread/name/set", {
          threadId: lane.threadId,
          name: `Codex Fleet: ${lane.id} — ${lane.label}`
        }).catch((error) => {
          if (error?.rpcCode !== -32601 && !/unknown (variant|method)/i.test(error?.message ?? "")) {
            throw error;
          }
        });
      }
      this.updateLane(
        lane,
        { status: "running", phase: "starting" },
        "lane.started",
        { threadId: lane.threadId }
      );
      await this.dispatchTurn(lane, {
        threadId: lane.threadId,
        cwd: lane.workspacePath,
        approvalPolicy: lane.interactive === true ? "on-request" : "never",
        sandboxPolicy: sandboxPolicyForLane(lane),
        input: this.turnInput(lane, buildExecutionPrompt(prompt, {
          verificationPlan: lane.verificationPlan,
          includePosture: false
        })),
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
      return copyLane(lane);
    } catch (error) {
      const unknown = isAcceptanceUnknown(error);
      this.updateLane(
        lane,
        unknown
          ? { status: "outcome_unknown", phase: "outcome_unknown", ...runtimeBlocker(error) }
          : { status: "failed", phase: "failed", exitReason: redactText(error.message) },
        unknown ? "lane.outcome-unknown" : "lane.failed",
        { message: lane.exitReason }
      );
      throw error;
    }
  }

  async beginReportRepair(lane, prompt, diagnostics = null) {
    if ((lane.reportRepairAttempts ?? 0) >= REPORT_REPAIR_LIMIT) {
      const reason = "Fleet could not repair the lane's structured result after one report-only retry.";
      this.updateLane(
        lane,
        {
          status: "outcome_unknown",
          phase: "outcome_unknown",
          exitReason: reason,
          outcomeDiagnostics: diagnostics ?? lane.outcomeDiagnostics,
          stopReason: reason
        },
        "lane.outcome-unknown",
        { threadId: lane.threadId, turnId: lane.turnId }
      );
      return;
    }
    const priorMessage = lane.lastMessage;
    const attempt = (lane.reportRepairAttempts ?? 0) + 1;
    this.unbindTurn(lane);
    this.updateLane(
      lane,
      {
        status: "running",
        phase: `repairing-report ${attempt}/${REPORT_REPAIR_LIMIT}`,
        lastMessage: priorMessage,
        reportRepairAttempts: attempt,
        outcomeDiagnostics: diagnostics ?? lane.outcomeDiagnostics,
        controllerRequest: null,
        stopReason: null
      },
      "lane.report-repairing",
      { threadId: lane.threadId, attempt, mutationDisabled: true }
    );
    try {
      await this.dispatchTurn(lane, {
        threadId: lane.threadId,
        cwd: lane.workspacePath,
        approvalPolicy: "never",
        sandboxPolicy: Object.freeze({
          type: "readOnly",
          access: Object.freeze({ type: "fullAccess" }),
          networkAccess: false
        }),
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
    } catch (error) {
      const reason = `Report-only recovery failed: ${redactText(error?.message ?? error)}`;
      this.updateLane(
        lane,
        {
          status: "outcome_unknown",
          phase: "outcome_unknown",
          exitReason: reason,
          stopReason: reason,
          outcomeDiagnostics: diagnostics ?? lane.outcomeDiagnostics
        },
        "lane.outcome-unknown",
        { threadId: lane.threadId, attempt }
      );
    }
  }

  async beginAutomaticContinuation(lane, prompt) {
    const attempt = lane.automaticContinuations + 1;
    this.unbindTurn(lane);
    this.updateLane(
      lane,
      {
        status: "running",
        phase: `recovering ${attempt}/${MAX_AUTOMATIC_CONTINUATIONS}`,
        exitReason: null,
        lastMessage: null,
        automaticContinuations: attempt
      },
      "lane.auto-continuing",
      { threadId: lane.threadId, attempt }
    );
    try {
      await this.dispatchTurn(lane, {
        threadId: lane.threadId,
        cwd: lane.workspacePath,
        approvalPolicy: lane.interactive === true ? "on-request" : "never",
        sandboxPolicy: sandboxPolicyForLane(lane),
        input: this.turnInput(lane, buildExecutionPrompt(prompt, {
          verificationPlan: lane.verificationPlan,
          includePosture: false
        })),
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
    } catch (error) {
      const unknown = isAcceptanceUnknown(error);
      this.updateLane(
        lane,
        unknown
          ? {
            status: "outcome_unknown",
            phase: "outcome_unknown",
            ...runtimeBlocker(error)
          }
          : {
            status: "blocked",
            phase: "needs-controller",
            ...runtimeBlocker(error)
          },
        unknown ? "lane.outcome-unknown" : "lane.auto-continuation-failed",
        { threadId: lane.threadId, attempt }
      );
    }
  }

  async beginContinuation(lane, prompt) {
    const previous = {
      status: lane.status,
      phase: lane.phase,
      turnId: lane.turnId,
      lastMessage: lane.lastMessage,
      exitReason: lane.exitReason,
      outcome: lane.outcome,
      workPerformed: lane.workPerformed,
      evidenceRefs: lane.evidenceRefs,
      verification: lane.verification,
      verificationResults: lane.verificationResults,
      artifactRefs: lane.artifactRefs,
      commitRefs: lane.commitRefs,
      configChanges: lane.configChanges,
      outcomeDiagnostics: lane.outcomeDiagnostics,
      controllerRequest: lane.controllerRequest,
      stopReason: lane.stopReason,
      automaticContinuations: lane.automaticContinuations,
      reportRepairAttempts: lane.reportRepairAttempts,
      updatedAt: lane.updatedAt
    };
    this.unbindTurn(lane);
    this.updateLane(
      lane,
      {
        status: "running",
        phase: "continuing",
        exitReason: null,
        lastMessage: null,
        outcome: null,
        workPerformed: Object.freeze([]),
        evidenceRefs: Object.freeze([]),
        verification: Object.freeze([]),
        verificationResults: Object.freeze([]),
        artifactRefs: Object.freeze([]),
        commitRefs: Object.freeze([]),
        configChanges: Object.freeze([]),
        outcomeDiagnostics: null,
        controllerRequest: null,
        stopReason: null,
        automaticContinuations: 0,
        reportRepairAttempts: 0
      },
      "lane.continued",
      { threadId: lane.threadId }
    );
    try {
      await this.dispatchTurn(lane, {
        threadId: lane.threadId,
        cwd: lane.workspacePath,
        approvalPolicy: lane.interactive === true ? "on-request" : "never",
        sandboxPolicy: sandboxPolicyForLane(lane),
        input: this.turnInput(lane, buildExecutionPrompt(prompt, {
          verificationPlan: lane.verificationPlan,
          includePosture: false
        })),
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
      return copyLane(lane);
    } catch (error) {
      this.unbindTurn(lane);
      const unknown = isAcceptanceUnknown(error);
      Object.assign(
        lane,
        previous,
        unknown
          ? { status: "outcome_unknown", phase: "outcome_unknown", ...runtimeBlocker(error) }
          : {}
      );
      if (previous.turnId && !unknown) {
        lane.retiredTurnIds?.delete(previous.turnId);
        this.turnToLane.set(previous.turnId, lane.id);
      }
      this.emit(lane.id, unknown ? "lane.outcome-unknown" : "lane.continuation-rejected", {
        message: transcriptText(error?.message ?? "Continuation was rejected.")
      });
      throw error;
    }
  }

  async continueLane(id, message) {
    this.assertMutableProtocol();
    const lane = this.lanes.get(id);
    if (!lane) {
      throw new Error(`Unknown lane: ${id}.`);
    }
    const resumable = lane.status === "complete"
      || (lane.status === "blocked" && lane.phase === "needs-controller");
    if (!resumable) {
      throw new Error(`Lane ${id} can only continue after completion or controller attention.`);
    }
    return this.beginContinuation(lane, assertPrompt(message, "Follow-up message"));
  }

  async resumeLane(record, workspacePath, message) {
    this.assertMutableProtocol();
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("Persisted lane record must be an object.");
    }
    const resumable = record.status === "complete"
      || (record.status === "blocked" && record.phase === "needs-controller");
    if (!resumable) {
      throw new Error(
        `Lane ${String(record.id)} can only resume after completion or controller attention.`
      );
    }
    if (!path.isAbsolute(workspacePath ?? "")) {
      throw new TypeError("Lane workspacePath must be absolute.");
    }
    if (this.lanes.has(record.id)) {
      throw new Error(`Lane already exists: ${record.id}.`);
    }

    const authority = normalizeAuthority(record.authority);
    const validated = createLane({ ...record, authority });
    const lane = {
      ...validated,
      ...(record.tokenUsage ? { tokenUsage: normalizeTokenUsage(record.tokenUsage) } : {}),
      authority,
      workspacePath: path.resolve(workspacePath),
      retiredTurnIds: new Set(record.turnId ? [record.turnId] : []),
      interactive: record.interactive === true,
      status: record.status,
      phase: record.phase,
      threadId: assertRuntimeId(record.threadId, "Persisted Codex thread id"),
      turnId: record.turnId ?? null,
      lastMessage: record.lastMessage ? redactText(record.lastMessage) : null,
      exitReason: null,
      outcome: record.outcome ?? null,
      workPerformed: Object.freeze(record.workPerformed ?? []),
      evidenceRefs: Object.freeze(record.evidenceRefs ?? []),
      verification: Object.freeze(record.verification ?? []),
      verificationResults: Object.freeze(record.verificationResults ?? []),
      artifactRefs: Object.freeze(record.artifactRefs ?? []),
      commitRefs: Object.freeze(record.commitRefs ?? []),
      configChanges: Object.freeze(record.configChanges ?? []),
      outcomeDiagnostics: record.outcomeDiagnostics ?? null,
      controllerRequest: record.controllerRequest ?? null,
      stopReason: record.stopReason ?? null,
      automaticContinuations: 0,
      reportRepairAttempts: 0,
      verificationPlan: record.verificationPlan ?? null,
      sharedContext: null,
      preflight: record.preflight ?? null,
      skillInputs: Object.freeze([])
    };
    await this.prepareSkillInputs(lane);
    this.lanes.set(lane.id, lane);
    this.bindThread(lane, lane.threadId);
    await this.broker.request("thread/resume", {
      threadId: lane.threadId,
      cwd: lane.workspacePath,
      model: lane.model,
      approvalPolicy: lane.interactive === true ? "on-request" : "never",
      sandboxPolicy: sandboxPolicyForLane(lane),
      excludeTurns: true
    });
    return this.beginContinuation(lane, assertPrompt(message, "Follow-up message"));
  }

  async steerLane(id, message, expectedIdentity = null) {
    this.assertMutableProtocol();
    const lane = this.lanes.get(id);
    if (!lane) throw new Error(`Unknown lane: ${id}.`);
    if (lane.status !== "running" || !lane.threadId || !lane.turnId) {
      throw new Error(`Lane ${id} has no active turn that can accept a message.`);
    }
    if (
      expectedIdentity
      && (
        expectedIdentity.threadId !== lane.threadId
        || expectedIdentity.turnId !== lane.turnId
      )
    ) {
      throw new Error(`Lane ${id} target identity changed; message was refused.`);
    }
    const prompt = assertPrompt(message, "Lane message");
    const response = await this.broker.request("turn/steer", {
      threadId: lane.threadId,
      expectedTurnId: lane.turnId,
      input: this.turnInput(lane, prompt)
    });
    if (response?.turnId && response.turnId !== lane.turnId) {
      throw new Error(`Lane ${id} active turn identity changed while steering.`);
    }
    this.emit(lane.id, "turn.steered", { threadId: lane.threadId, turnId: lane.turnId });
    return copyLane(lane);
  }

  async listThreads(options = {}) {
    if (this.closed) throw new Error("Fleet runtime is closed.");
    const cacheKey = JSON.stringify({ archived: options.archived === true });
    if (this.nativeInventoryCache?.key === cacheKey && this.nativeInventoryCache.expiresAt > Date.now()) return this.nativeInventoryCache.value;
    if (this.nativeInventoryRequest?.key === cacheKey) return this.nativeInventoryRequest.promise;
    const promise = discoverNativeThreads((method, params) => this.broker.request(method, params), { ...options, includeLoaded: true }).then((value) => {
      this.nativeInventoryCache = { key: cacheKey, value, expiresAt: Date.now() + 5000 }; return value;
    });
    this.nativeInventoryRequest = { key: cacheKey, promise };
    try { return await promise; } finally { if (this.nativeInventoryRequest?.promise === promise) this.nativeInventoryRequest = null; }
  }

  async probeContinuation(record) {
    if (this.closed) throw new Error("Fleet runtime is closed.");
    const threadId = assertRuntimeId(record?.threadId, "Persisted Codex thread id");
    const previousTurnId = record?.pendingContinuation?.previousTurnId ?? record?.turnId ?? null;
    try {
      await this.broker.request("thread/read", { threadId, includeTurns: false });
      const page = await this.broker.request("thread/turns/list", {
        threadId,
        cursor: null,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full"
      });
      const latest = Array.isArray(page?.data) ? page.data[0] : null;
      if (!latest?.id) {
        return Object.freeze({ state: "unknown", threadId, previousTurnId, latestTurnId: null });
      }
      if (latest.id === previousTurnId) {
        return Object.freeze({
          state: "not-started",
          threadId,
          previousTurnId,
          latestTurnId: latest.id,
          latestStatus: latest.status ?? null
        });
      }
      const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(latest.status);
      return Object.freeze({
        state: terminal ? "terminal-started" : "started",
        threadId,
        previousTurnId,
        latestTurnId: latest.id,
        latestStatus: latest.status ?? null
      });
    } catch (error) {
      return Object.freeze({
        state: "unknown",
        threadId,
        previousTurnId,
        latestTurnId: null,
        error: safePreflightText(error?.message ?? error)
      });
    }
  }

  async readThread(threadId) {
    if (this.closed) throw new Error("Fleet runtime is closed.");
    const validatedThreadId = assertRuntimeId(threadId, "Codex thread id");
    const response = await this.broker.request("thread/read", {
      threadId: validatedThreadId,
      includeTurns: false
    });
    let turns = [];
    let historyMode = "paged";
    try {
      const page = await this.broker.request("thread/turns/list", {
        threadId: validatedThreadId,
        cursor: null,
        limit: MAX_TRANSCRIPT_TURNS,
        sortDirection: "desc",
        itemsView: "full"
      });
      turns = Array.isArray(page?.data) ? [...page.data].reverse() : [];
    } catch (error) {
      if (error?.rpcCode === -32601 || /unknown (?:method|variant)|not implemented/iu.test(error?.message ?? "")) {
        historyMode = "metadata-only";
      } else {
        throw error;
      }
    }
    return Object.freeze({
      ...safeThreadSession({ ...response?.thread, turns }),
      historyMode,
      historyTruncated: historyMode === "paged" && turns.length >= MAX_TRANSCRIPT_TURNS
    });
  }

  async interruptLane(id) {
    this.assertMutableProtocol();
    const lane = this.lanes.get(id);
    if (!lane) {
      throw new Error(`Unknown lane: ${id}.`);
    }
    if (lane.status !== "running" || !lane.threadId || !lane.turnId) {
      throw new Error(`Lane ${id} has no active owned turn to interrupt.`);
    }
    await this.broker.request("turn/interrupt", {
      threadId: lane.threadId,
      turnId: lane.turnId
    });
    this.inbox.invalidateTurn(lane.threadId, lane.turnId, "interrupt-acknowledged");
    this.emit(lane.id, "lane.interrupt-requested", {
      threadId: lane.threadId,
      turnId: lane.turnId
    });
    return copyLane(lane);
  }

  inspectLane(id) {
    this.inbox.sweep();
    const lane = this.lanes.get(id);
    return lane ? copyLane(lane) : null;
  }

  listLanes(workspace = null) {
    return [...this.lanes.values()]
      .filter((lane) => workspace === null
        || lane.workspaceKey === workspace
        || lane.workspacePath === workspace)
      .map(copyLane);
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inbox.disconnect();
    this.broker.setEventHandler(null);
    await this.broker.close();
  }
}

export async function createRuntime(options = {}) {
  const broker = await createAppServerBroker({
    codexCommand: options.codexCommand ?? "codex",
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs,
    captureOwnedProcess: options.captureOwnedProcess,
    stopOwnedProcessTree: options.stopOwnedProcessTree
  });
  return new FleetRuntime(broker, options);
}
