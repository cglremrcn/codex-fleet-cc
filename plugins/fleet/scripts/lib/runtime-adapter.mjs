import path from "node:path";

import {
  BROKER_PROTOCOL_VERSION,
  createAppServerBroker
} from "../app-server-broker.mjs";
import { normalizeAuthority } from "./authority.mjs";
import { createLane } from "./domain.mjs";
import { redactText } from "./redaction.mjs";

const MAX_PROMPT_LENGTH = 128 * 1024;
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
    exitReason: lane.exitReason
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

class FleetRuntime {
  constructor(broker, options = {}) {
    this.broker = broker;
    this.options = options;
    this.lanes = new Map();
    this.threadToLane = new Map();
    this.pendingNotifications = new Map();
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

  handleNotification(message) {
    if (IGNORED_NOTIFICATION_METHODS.has(message.method)) {
      return;
    }
    const threadId = notificationThreadId(message);
    if (!threadId) {
      return;
    }
    const laneId = this.threadToLane.get(threadId);
    if (!laneId) {
      const pending = this.pendingNotifications.get(threadId) ?? [];
      if (pending.length < 64) {
        pending.push(message);
        this.pendingNotifications.set(threadId, pending);
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
    if (turnId) {
      lane.turnId = turnId;
    }

    switch (message.method) {
      case "thread/started":
        this.emit(lane.id, "thread.started", { threadId: lane.threadId });
        break;
      case "turn/started":
        this.updateLane(
          lane,
          { status: "running", phase: "running" },
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
        const status = turnStatus === "completed"
          ? "complete"
          : turnStatus === "interrupted"
            ? "cancelled"
            : "failed";
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
      threadId: null,
      turnId: null,
      lastMessage: null,
      exitReason: null
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
        ephemeral: false
      });
      this.bindThread(lane, thread.thread.id);
      await this.broker.request("thread/name/set", {
        threadId: lane.threadId,
        name: `Codex Fleet: ${lane.id} — ${lane.label}`
      }).catch((error) => {
        if (error?.rpcCode !== -32601 && !/unknown (variant|method)/i.test(error?.message ?? "")) {
          throw error;
        }
      });
      this.updateLane(
        lane,
        { status: "running", phase: "starting" },
        "lane.started",
        { threadId: lane.threadId }
      );
      const turn = await this.broker.request("turn/start", {
        threadId: lane.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: lane.model,
        effort: lane.effort,
        outputSchema: null
      });
      lane.turnId = turn.turn?.id ?? lane.turnId;
      return copyLane(lane);
    } catch (error) {
      this.updateLane(
        lane,
        { status: "failed", phase: "failed", exitReason: redactText(error.message) },
        "lane.failed",
        { message: lane.exitReason }
      );
      throw error;
    }
  }

  async continueLane(id, message) {
    this.assertMutableProtocol();
    const lane = this.lanes.get(id);
    if (!lane) {
      throw new Error(`Unknown lane: ${id}.`);
    }
    if (lane.status !== "complete") {
      throw new Error(`Lane ${id} can only continue after a completed turn.`);
    }
    const prompt = assertPrompt(message, "Follow-up message");
    await this.broker.request("thread/resume", {
      threadId: lane.threadId,
      cwd: lane.workspacePath,
      model: lane.model,
      approvalPolicy: "never",
      sandbox: lane.authority.sandbox
    });
    lane.turnId = null;
    this.updateLane(
      lane,
      { status: "running", phase: "continuing", exitReason: null },
      "lane.continued",
      { threadId: lane.threadId }
    );
    const turn = await this.broker.request("turn/start", {
      threadId: lane.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: lane.model,
      effort: lane.effort,
      outputSchema: null
    });
    lane.turnId = turn.turn?.id ?? lane.turnId;
    return copyLane(lane);
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
