import { StringDecoder } from "node:string_decoder";

import { authorizeAction } from "./authority.mjs";
import { createInputDecoder, reduceInput } from "./tui-input.mjs";
import { buildViewModel, renderScreen } from "./tui-render.mjs";
import { withTerminalSession } from "./tui-session.mjs";

const PANELS = Object.freeze(["detail", "evidence", "authority"]);
const MOTION_STATUSES = new Set(["queued", "running", "complete"]);
const CANCELLABLE_STATUSES = new Set(["queued", "starting", "running"]);
const MAX_FILTER_LENGTH = 64;
const MAX_COMPOSER_LENGTH = 4_096;
export const CONSOLE_TICK_MS = 250;
const ESCAPE_FLUSH_MS = 35;

function defaultSnapshot(cwd) {
  const pieces = String(cwd ?? "local-workspace").split(/[\\/]/).filter(Boolean);
  return {
    schemaVersion: 1,
    workspace: { name: pieces.at(-1) ?? "local-workspace", branch: "branch-not-reported" },
    runtime: { health: "unknown", protocol: "unknown", activeLimit: null },
    lanes: [],
    updatedAt: null
  };
}

function normalizeSnapshot(value, cwd) {
  const fallback = defaultSnapshot(cwd);
  if (!value || typeof value !== "object") return fallback;
  return {
    ...fallback,
    ...value,
    workspace: { ...fallback.workspace, ...(value.workspace ?? {}) },
    runtime: { ...fallback.runtime, ...(value.runtime ?? {}) },
    lanes: Array.isArray(value.lanes) ? value.lanes : []
  };
}

function filteredSnapshot(snapshot, query) {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) return snapshot;
  return {
    ...snapshot,
    lanes: snapshot.lanes.filter((lane) => [
      lane.id,
      lane.role,
      lane.label,
      lane.status,
      lane.phase,
      lane.model
    ].some((value) => String(value ?? "").toLocaleLowerCase("en-US").includes(needle)))
  };
}

function safeTerminal(value = {}) {
  return {
    columns: Number.isInteger(value.columns) ? Math.max(1, value.columns) : 80,
    rows: Number.isInteger(value.rows) ? Math.max(1, value.rows) : 24
  };
}

function selectedFormationFrame(status, tick) {
  if (MOTION_STATUSES.has(status)) return tick % 4;
  if (status === "blocked") return 3;
  if (status === "failed" || status === "outcome_unknown") return 0;
  return 2;
}

function boundedStatus(value, width) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  if (normalized.length <= width) return normalized;
  return width <= 1 ? normalized.slice(0, width) : `${normalized.slice(0, width - 1)}…`;
}

function decorateFooter(screen, state, columns) {
  if (state.session) return screen;
  let message = null;
  if (state.composer) {
    message = `FOLLOW-UP / ${state.composer.laneId} · EXISTING CODEX THREAD · ${state.composer.value || "type a message"} · Enter send · Esc discard`;
  } else if (state.confirmation) {
    message = `[CONFIRM] cancel ${state.confirmation.laneId} · C confirm · Q return`;
  } else if (state.filterEditing) {
    message = `SEARCH LANES › ${state.filterQuery || "type to filter"}_ · MATCHES ${state.laneCount}/${state.totalLaneCount} · Enter: Keep · Esc: Clear`;
  } else if (state.filterQuery) {
    message = `SEARCH LANES › ${state.filterQuery} · MATCHES ${state.laneCount}/${state.totalLaneCount} · /: Edit or clear`;
  } else if (state.notice) {
    message = state.notice;
  }
  if (!message) return screen;
  const lines = screen.split("\n");
  lines[lines.length - 1] = boundedStatus(message, columns);
  return lines.join("\n");
}

function defaultRuntime() {
  return Object.freeze({});
}

function actionFailure(error) {
  return error?.code === "AUTHORITY_DENIED" ? error.message : "action-failed";
}

export function createConsoleController(options = {}) {
  const write = typeof options.write === "function" ? options.write : () => undefined;
  const writeControl = typeof options.writeControl === "function" ? options.writeControl : write;
  const render = options.render ?? renderScreen;
  const readSnapshot = options.readSnapshot;
  const runtime = options.runtime ?? defaultRuntime();
  const spawnEditor = options.spawnEditor;
  const draftPath = options.draftPath ?? null;
  const preferences = options.preferences ?? {};
  let snapshot = normalizeSnapshot(options.snapshot, options.cwd);
  let terminal = safeTerminal(options.terminal);
  let ui = {
    laneCount: snapshot.lanes.length,
    totalLaneCount: snapshot.lanes.length,
    selectedIndex: 0,
    panelIndex: 0,
    panelCount: PANELS.length,
    motion: preferences.reducedMotion !== true,
    exitRequested: false,
    filterEditing: false,
    filterQuery: "",
    frame: 0,
    notice: null,
    confirmation: null,
    composer: null,
    session: null,
    refreshTick: 0
  };
  let previousScreen = null;
  let firstRender = true;

  function visibleSnapshot() {
    return filteredSnapshot(snapshot, ui.filterQuery);
  }

  function clampSelection() {
    const lanes = visibleSnapshot().lanes;
    ui.laneCount = lanes.length;
    ui.totalLaneCount = snapshot.lanes.length;
    if (lanes.length === 0) ui.selectedIndex = 0;
    else ui.selectedIndex = Math.max(0, Math.min(ui.selectedIndex, lanes.length - 1));
  }

  function selectedLane() {
    clampSelection();
    return visibleSnapshot().lanes[ui.selectedIndex] ?? null;
  }

  async function renderCurrent() {
    clampSelection();
    const lane = selectedLane();
    const view = buildViewModel(
      visibleSnapshot(),
      ui.selectedIndex,
      PANELS[ui.panelIndex]
    );
    const frame = selectedFormationFrame(lane?.status, ui.frame);
    const screen = decorateFooter(render(view, terminal, {
      ...preferences,
      motion: ui.motion,
      reducedMotion: preferences.reducedMotion === true || ui.motion === false,
      frame,
      session: ui.session,
      composer: ui.composer,
      notice: ui.notice
    }), ui, terminal.columns);
    if (screen === previousScreen) return false;
    previousScreen = screen;
    write(`${firstRender ? "\u001b[2J" : ""}\u001b[H${screen}`);
    firstRender = false;
    return true;
  }

  function setNotice(value) {
    ui.notice = boundedStatus(value, 160);
    ui.confirmation = null;
  }

  function authorize(lane, action, context = {}) {
    try {
      return authorizeAction(lane?.authority ?? {}, action, context);
    } catch {
      return { allowed: false, reason: "malformed-lane-authority" };
    }
  }

  async function runRuntimeAction(method, lane, ...args) {
    if (typeof runtime[method] !== "function") {
      setNotice(`${method}-control-unavailable`);
      return false;
    }
    try {
      await runtime[method](lane, ...args);
      setNotice(method === "followUp" || method === "message"
        ? `MESSAGE SENT · ${lane.id} · SAME CODEX THREAD`
        : `${method}-requested · ${lane.id}`);
      return true;
    } catch (error) {
      setNotice(actionFailure(error));
      return false;
    }
  }

  async function refreshSession() {
    if (!ui.session) return false;
    const laneId = ui.session.laneId;
    const lane = snapshot.lanes.find((candidate) => candidate.id === laneId);
    if (!lane) {
      ui.session = { ...ui.session, loading: false, error: "Lane is no longer available." };
      return false;
    }
    if (typeof runtime.session !== "function") {
      ui.session = {
        ...ui.session,
        loading: false,
        error: "Runtime thread inspection is unavailable."
      };
      return false;
    }
    try {
      const session = await runtime.session(lane);
      if (ui.session?.laneId !== laneId) return false;
      ui.session = {
        ...session,
        laneId,
        loading: false,
        error: null,
        scroll: ui.session.scroll ?? 0,
        activityExpanded: ui.session.activityExpanded === true
      };
      return true;
    } catch (error) {
      if (ui.session?.laneId === laneId) {
        ui.session = {
          ...ui.session,
          loading: false,
          error: boundedStatus(error?.message ?? "Session read failed.", 160)
        };
      }
      return false;
    }
  }

  async function openSession() {
    const lane = selectedLane();
    if (!lane) {
      setNotice("NO LANE SELECTED");
      return;
    }
    ui.filterEditing = false;
    ui.confirmation = null;
    ui.notice = null;
    ui.session = {
      laneId: lane.id,
      threadId: lane.threadId ?? null,
      source: "fleet",
      canAcceptDirectInput: Boolean(lane.threadId),
      messages: [],
      loading: true,
      error: null,
      scroll: 0,
      activityExpanded: false
    };
    // The authoritative thread identity may only be available from thread/read.
    // Keep the composer available while that session metadata is loading so a
    // freshly persisted terminal lane behaves exactly like an existing one.
    ui.composer = { laneId: lane.id, value: "" };
    await renderCurrent();
    await refreshSession();
  }

  function closeSession() {
    ui.session = null;
    ui.composer = null;
    setNotice("RETURNED TO FLEET DASHBOARD");
  }

  async function confirmCancellation() {
    const lane = selectedLane();
    const pinned = ui.confirmation;
    if (
      !lane
      || pinned?.laneId !== lane.id
      || pinned.threadId !== (lane.threadId ?? null)
      || pinned.turnId !== (lane.turnId ?? null)
    ) {
      setNotice("confirmation-target-changed");
      return;
    }
    const decision = authorize(lane, "process.stop", {
      owned: lane.owned === true || typeof lane.threadId === "string"
    });
    if (!decision.allowed) {
      setNotice(decision.reason);
      return;
    }
    await runRuntimeAction("cancel", lane, {
      threadId: pinned.threadId,
      turnId: pinned.turnId
    });
  }

  async function retryOrReconcile() {
    const lane = selectedLane();
    if (!lane) return;
    if (lane.status === "outcome_unknown" && !lane.reconciliationRef) {
      await runRuntimeAction("reconcile", lane);
      return;
    }
    const decision = authorize(lane, "retry.operation", {
      outcome: lane.status === "outcome_unknown" ? "unknown" : "known",
      reconciled: Boolean(lane.reconciliationRef)
    });
    if (!decision.allowed) {
      setNotice(decision.reason);
      return;
    }
    await runRuntimeAction("retry", lane);
  }

  function copyLaneIdentifier() {
    const lane = selectedLane();
    if (!lane) return;
    const identifier = String(lane.id).slice(0, 64);
    const encoded = Buffer.from(identifier, "utf8").toString("base64");
    writeControl(`\u001b]52;c;${encoded}\u0007`);
    setNotice(`COPY ${identifier} · OSC 52 sent; identifier remains visible here`);
  }

  function selectMouseRow(event) {
    const firstLaneRow = 5;
    const index = Math.floor((event.row - firstLaneRow) / 2);
    if (event.row >= firstLaneRow && index >= 0 && index < ui.laneCount) {
      ui.selectedIndex = index;
      ui.notice = null;
    }
  }

  async function dispatch(event) {
    if (!event || typeof event !== "object") return { exit: false };
    if (event.type === "tick") {
      ui.refreshTick += 1;
      if (typeof readSnapshot === "function") {
        try {
          snapshot = normalizeSnapshot(await readSnapshot(), options.cwd);
        } catch {
          setNotice("state-read-failed");
        }
      }
      if (ui.motion && MOTION_STATUSES.has(selectedLane()?.status)) ui.frame += 1;
      if (ui.session && ui.refreshTick % 4 === 0 && !ui.composer?.value) {
        await refreshSession();
      }
    } else if (event.type === "closeSession") {
      closeSession();
    } else if (event.type === "filter") {
      ui.filterEditing = true;
      ui.notice = null;
    } else if (event.type === "text" && ui.composer) {
      ui.composer.value = `${ui.composer.value}${event.value}`.slice(0, MAX_COMPOSER_LENGTH);
      ui.notice = null;
    } else if (event.type === "text" && ui.filterEditing) {
      ui.filterQuery = `${ui.filterQuery}${event.value}`.slice(0, MAX_FILTER_LENGTH);
      ui.selectedIndex = 0;
    } else if (event.type === "backspace" && ui.composer) {
      ui.composer.value = Array.from(ui.composer.value).slice(0, -1).join("");
    } else if (event.type === "backspace" && ui.filterEditing) {
      ui.filterQuery = Array.from(ui.filterQuery).slice(0, -1).join("");
      ui.selectedIndex = 0;
    } else if (event.type === "applyFilter" && ui.filterEditing) {
      ui.filterEditing = false;
      setNotice(ui.filterQuery ? `FILTER ACTIVE · ${ui.filterQuery}` : "FILTER CLEARED");
    } else if (event.type === "clearFilter") {
      ui.filterEditing = false;
      ui.filterQuery = "";
      setNotice("FILTER CLEARED");
    } else if (event.type === "help") {
      setNotice(
        "FLEET CONTROLS · ↑↓ select · Enter open agent · Tab change view · / search · X cancel · P motion · Ctrl+G return"
      );
    } else if (event.type === "activate") {
      await openSession();
    } else if (event.type === "edit") {
      if (!draftPath) setNotice("draft-path-not-provided");
      else if (typeof spawnEditor !== "function") setNotice("original-editor-unavailable");
      else {
        try {
          await spawnEditor(draftPath);
          setNotice("ORIGINAL EDITOR RETURNED · Claude draft preserved");
        } catch {
          setNotice("original-editor-failed");
        }
      }
    } else if (event.type === "message") {
      const lane = selectedLane();
      const decision = authorize(lane, "process.start");
      if (!decision.allowed) setNotice(decision.reason);
      else await openSession();
    } else if (event.type === "submitMessage" && ui.composer) {
      const composer = ui.composer;
      const lane = snapshot.lanes.find((candidate) => candidate.id === composer.laneId);
      const command = composer.value.trim().toLocaleLowerCase("en-US");
      if (command === "/" || command === "/help") {
        setNotice("FLEET LOCAL COMMANDS · /latest · /activity · /status · /back");
        ui.composer = { laneId: composer.laneId, value: "" };
      } else if (command === "/latest") {
        ui.session.scroll = 0;
        setNotice("TRANSCRIPT AT LATEST");
        ui.composer = { laneId: composer.laneId, value: "" };
      } else if (command === "/activity") {
        ui.session.activityExpanded = ui.session.activityExpanded !== true;
        setNotice(ui.session.activityExpanded ? "ACTIVITY EXPANDED" : "ACTIVITY COLLAPSED");
        ui.composer = { laneId: composer.laneId, value: "" };
      } else if (command === "/status") {
        setNotice(`LANE ${lane?.id ?? "UNKNOWN"} · ${lane?.status ?? "unknown"} · ${lane?.phase ?? "unknown"}`);
        ui.composer = { laneId: composer.laneId, value: "" };
      } else if (command === "/back") {
        closeSession();
      } else if (!composer.value.trim()) setNotice("follow-up-message-empty");
      else if (!lane) setNotice("follow-up-target-changed");
      else {
        const method = typeof runtime.message === "function" ? "message" : "followUp";
        const succeeded = await runRuntimeAction(method, lane, composer.value);
        if (succeeded) {
          ui.composer = { laneId: composer.laneId, value: "" };
          if (ui.session) {
            ui.session.scroll = 0;
            await refreshSession();
          }
        }
      }
    } else if (event.type === "discardMessage" && ui.composer) {
      closeSession();
    } else if (event.type === "cancel") {
      const lane = selectedLane();
      if (lane && !CANCELLABLE_STATUSES.has(lane.status)) {
        setNotice(`${String(lane.status).toUpperCase()} LANE · NOTHING TO CANCEL`);
      } else if (lane) {
        ui.confirmation = {
          action: "cancel",
          laneId: lane.id,
          threadId: lane.threadId ?? null,
          turnId: lane.turnId ?? null
        };
        ui.composer = null;
        ui.notice = null;
      }
    } else if (event.type === "confirm") {
      if (ui.confirmation?.action === "cancel") await confirmCancellation();
      else copyLaneIdentifier();
    } else if (event.type === "reconcile") {
      await retryOrReconcile();
    } else if (event.type === "mouseDown") {
      selectMouseRow(event);
    } else if (event.type === "resize") {
      terminal = safeTerminal(event);
    } else if (event.type === "invalidInput") {
      setNotice(event.reason);
    } else if (event.type === "move" && ui.session) {
      const delta = event.delta < 0 ? 3 : -3;
      const maximum = Math.max(0, (ui.session.messages?.length ?? 1) * 8);
      ui.session.scroll = Math.max(0, Math.min(maximum, (ui.session.scroll ?? 0) + delta));
    } else if (event.type === "move") {
      if (ui.laneCount <= 1) {
        setNotice(`ONLY ${ui.laneCount} LANE · selection unchanged`);
      } else {
        ui = { ...ui, ...reduceInput(ui, event) };
        ui.notice = null;
      }
    } else if (event.type === "cyclePanel") {
      ui = { ...ui, ...reduceInput(ui, event) };
      setNotice(`VIEW ${PANELS[ui.panelIndex].toUpperCase()}`);
    } else if (event.type === "toggleMotion") {
      if (preferences.reducedMotion === true) {
        setNotice("KITE MOTION LOCKED · REDUCED MOTION");
      } else {
        ui = { ...ui, ...reduceInput(ui, event) };
        setNotice(ui.motion ? "KITE MOTION RESUMED" : "KITE MOTION PAUSED");
      }
    } else {
      ui = { ...ui, ...reduceInput(ui, event) };
    }
    await renderCurrent();
    return {
      exit: ui.exitRequested,
      textMode: ui.composer ? "composer" : ui.filterEditing ? "filter" : false
    };
  }

  return Object.freeze({
    dispatch,
    render: renderCurrent,
    state: () => Object.freeze({ ...ui })
  });
}

function defaultClock() {
  return {
    setInterval: (callback, delay) => setInterval(callback, delay),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle)
  };
}

function removeEmitterListener(emitter, event, handler) {
  if (typeof emitter.off === "function") emitter.off(event, handler);
  else if (typeof emitter.removeListener === "function") emitter.removeListener(event, handler);
}

export async function runConsole(options = {}) {
  const io = options.io ?? { stdin: process.stdin, stdout: process.stdout, lifecycle: process };
  const clock = options.clock ?? defaultClock();
  const terminalSession = options.terminalSession ?? withTerminalSession;
  const readSnapshot = options.readSnapshot ?? (async () => defaultSnapshot(options.cwd));
  const initialSnapshot = await readSnapshot();

  return terminalSession(io, async ({ signal, suspend }) => {
    const decoder = createInputDecoder();
    const utf8Decoder = new StringDecoder("utf8");
    let acceptingWrites = true;
    const suspendedEditor = typeof options.spawnEditor === "function"
      ? (draftPath) => (
        typeof suspend === "function"
          ? suspend(() => options.spawnEditor(draftPath))
          : options.spawnEditor(draftPath)
      )
      : undefined;
    const controller = createConsoleController({
      ...options,
      snapshot: initialSnapshot,
      readSnapshot,
      spawnEditor: suspendedEditor,
      terminal: { columns: io.stdout.columns, rows: io.stdout.rows },
      write: (value) => acceptingWrites && io.stdout.write(value),
      writeControl: (value) => acceptingWrites && io.stdout.write(value)
    });
    let interval = null;
    let escapeTimer = null;
    let finished = false;
    let queue = Promise.resolve();

    return new Promise((resolve, reject) => {
      function cleanup() {
        if (interval !== null) clock.clearInterval(interval);
        if (escapeTimer !== null) (clock.clearTimeout ?? clearTimeout)(escapeTimer);
        removeEmitterListener(io.stdin, "data", onData);
        removeEmitterListener(io.stdout, "resize", onResize);
        signal?.removeEventListener?.("abort", onAbort);
      }

      function finish(error) {
        if (finished) return;
        finished = true;
        acceptingWrites = false;
        cleanup();
        if (error) reject(error);
        else resolve({ exitReason: signal?.aborted ? "signal" : "return" });
      }

    async function dispatchEvents(events) {
      for (const event of events) {
        if (finished) return;
        const result = await controller.dispatch(event);
        decoder.setTextMode(result.textMode);
        if (result.exit) finish();
      }
    }

    function enqueue(events) {
      queue = queue.then(() => dispatchEvents(events));
      queue.catch(finish);
    }

    function enqueueInput(chunk) {
      const decoded = utf8Decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      queue = queue.then(async () => {
        for (const character of decoded) {
          await dispatchEvents(decoder.push(Buffer.from(character)));
          if (finished) return;
        }
        scheduleEscapeFlush();
      });
      queue.catch(finish);
      }

      function scheduleEscapeFlush() {
        if (escapeTimer !== null) (clock.clearTimeout ?? clearTimeout)(escapeTimer);
        if (decoder.pendingBytes === 0) return;
        const schedule = clock.setTimeout ?? setTimeout;
        escapeTimer = schedule(() => {
          escapeTimer = null;
          enqueue(decoder.flush());
        }, ESCAPE_FLUSH_MS);
      }

      function onData(chunk) {
        enqueueInput(chunk);
      }

      function onResize() {
        enqueue([{
          type: "resize",
          columns: io.stdout.columns,
          rows: io.stdout.rows
        }]);
      }

      function onAbort() {
        finish();
      }

      io.stdin.on("data", onData);
      io.stdout.on?.("resize", onResize);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      interval = clock.setInterval(() => enqueue([{ type: "tick" }]), CONSOLE_TICK_MS);
      controller.render().catch(finish);
    });
  });
}
