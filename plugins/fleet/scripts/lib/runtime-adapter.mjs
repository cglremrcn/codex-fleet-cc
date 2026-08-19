import path from "node:path";

import {
  BROKER_PROTOCOL_VERSION,
  createAppServerBroker
} from "../app-server-broker.mjs";
import { normalizeAuthority } from "./authority.mjs";
import { createLane } from "./domain.mjs";
import {
  LANE_OUTCOME_SCHEMA,
  MAX_AUTOMATIC_CONTINUATIONS,
  buildExecutionPrompt,
  decideLaneOutcome
} from "./lane-outcome.mjs";
import { redactText } from "./redaction.mjs";

const MAX_PROMPT_LENGTH = 128 * 1024;
const MAX_TRANSCRIPT_ITEMS = 96;
const MAX_TRANSCRIPT_ITEM_LENGTH = 4_096;
const IGNORED_NOTIFICATION_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta"
]);

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

function copyLane(lane) {
  return Object.freeze({
    id: lane.id,
    role: lane.role,
    label: lane.label,
    workspaceKey: lane.workspaceKey,
    model: lane.model,
    effort: lane.effort,
    authority: lane.authority,
    status: lane.status,
    phase: lane.phase,
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
    artifactRefs: lane.artifactRefs,
    controllerRequest: lane.controllerRequest,
    stopReason: lane.stopReason,
    automaticContinuations: lane.automaticContinuations
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

class FleetRuntime {
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
    this.connectedProtocolVersion = options.brokerProtocolVersion
      ?? broker.protocolVersion;
    broker.setEventHandler((message) => this.handleNotification(message));
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
    if (lane.turnId && this.turnToLane.get(lane.turnId) === lane.id) {
      this.turnToLane.delete(lane.turnId);
    }
    lane.turnId = null;
  }

  bindTurn(lane, turnId) {
    const validated = assertRuntimeId(turnId, "Codex turn id");
    this.unbindTurn(lane);
    lane.turnId = validated;
    this.turnToLane.set(validated, lane.id);
    const buffered = this.pendingTurnNotifications.get(validated) ?? [];
    this.pendingTurnNotifications.delete(validated);
    for (const message of buffered) {
      this.applyNotification(lane, message);
    }
  }

  handleNotification(message) {
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
    const turnId = notificationTurnId(message);
    if (turnId && lane.turnId !== turnId) {
      this.unbindTurn(lane);
      lane.turnId = turnId;
      this.turnToLane.set(turnId, lane.id);
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
        const turnStatus = message.params?.turn?.status;
        if (turnStatus === "completed") {
          const decision = decideLaneOutcome(
            lane.lastMessage ?? "",
            lane.automaticContinuations,
            { authority: lane.authority }
          );
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
                artifactRefs: result.artifactRefs,
                controllerRequest: null,
                stopReason: result.stopReason
              },
              "turn.complete",
              { threadId: lane.threadId, turnId: lane.turnId }
            );
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
                artifactRefs: decision.result?.artifactRefs ?? Object.freeze([]),
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
            exitReason: turnStatus && status !== "complete" ? redactText(turnStatus) : null
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
      threadId: null,
      turnId: null,
      lastMessage: null,
      exitReason: null,
      outcome: null,
      workPerformed: Object.freeze([]),
      evidenceRefs: Object.freeze([]),
      verification: Object.freeze([]),
      artifactRefs: Object.freeze([]),
      controllerRequest: null,
      stopReason: null,
      automaticContinuations: 0
    };
    this.lanes.set(lane.id, lane);
    this.emit(lane.id, "lane.queued", {});

    try {
      const thread = await this.broker.request("thread/start", {
        cwd: lane.workspacePath,
        model: lane.model,
        approvalPolicy: "never",
        sandbox: lane.authority.sandbox,
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
      const turn = await this.broker.request("turn/start", {
        threadId: lane.threadId,
        input: [{ type: "text", text: buildExecutionPrompt(prompt), text_elements: [] }],
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
      if (turn.turn?.id) this.bindTurn(lane, turn.turn.id);
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
      const turn = await this.broker.request("turn/start", {
        threadId: lane.threadId,
        input: [{ type: "text", text: buildExecutionPrompt(prompt), text_elements: [] }],
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
      if (turn.turn?.id) this.bindTurn(lane, turn.turn.id);
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
      artifactRefs: lane.artifactRefs,
      controllerRequest: lane.controllerRequest,
      stopReason: lane.stopReason,
      automaticContinuations: lane.automaticContinuations,
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
        artifactRefs: Object.freeze([]),
        controllerRequest: null,
        stopReason: null,
        automaticContinuations: 0
      },
      "lane.continued",
      { threadId: lane.threadId }
    );
    try {
      const turn = await this.broker.request("turn/start", {
        threadId: lane.threadId,
        input: [{ type: "text", text: buildExecutionPrompt(prompt), text_elements: [] }],
        model: lane.model,
        effort: lane.effort,
        outputSchema: LANE_OUTCOME_SCHEMA
      });
      if (turn.turn?.id) this.bindTurn(lane, turn.turn.id);
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
      if (previous.turnId && !unknown) this.turnToLane.set(previous.turnId, lane.id);
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
      authority,
      workspacePath: path.resolve(workspacePath),
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
      artifactRefs: Object.freeze(record.artifactRefs ?? []),
      controllerRequest: record.controllerRequest ?? null,
      stopReason: record.stopReason ?? null,
      automaticContinuations: 0
    };
    this.lanes.set(lane.id, lane);
    this.bindThread(lane, lane.threadId);
    await this.broker.request("thread/resume", {
      threadId: lane.threadId,
      cwd: lane.workspacePath,
      model: lane.model,
      approvalPolicy: "never",
      sandbox: lane.authority.sandbox
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
      input: [{ type: "text", text: prompt, text_elements: [] }]
    });
    if (response?.turnId && response.turnId !== lane.turnId) {
      throw new Error(`Lane ${id} active turn identity changed while steering.`);
    }
    this.emit(lane.id, "turn.steered", { threadId: lane.threadId, turnId: lane.turnId });
    return copyLane(lane);
  }

  async readThread(threadId) {
    if (this.closed) throw new Error("Fleet runtime is closed.");
    const response = await this.broker.request("thread/read", {
      threadId: assertRuntimeId(threadId, "Codex thread id"),
      includeTurns: true
    });
    return safeThreadSession(response?.thread);
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
    this.emit(lane.id, "lane.interrupt-requested", {
      threadId: lane.threadId,
      turnId: lane.turnId
    });
    return copyLane(lane);
  }

  inspectLane(id) {
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
