import { authorizeAction } from "./authority.mjs";
import { createInputDecoder, reduceInput } from "./tui-input.mjs";
import { buildViewModel, renderScreen } from "./tui-render.mjs";
import { withTerminalSession } from "./tui-session.mjs";

const PANELS = Object.freeze(["lanes", "detail", "evidence", "authority", "controls"]);
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const MAX_FILTER_LENGTH = 64;
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
  if (ACTIVE_STATUSES.has(status)) return tick % 4;
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
  let message = null;
  if (state.confirmation) {
    message = `[CONFIRM] cancel ${state.confirmation.laneId} · C confirm · Q return`;
  } else if (state.filterEditing) {
    message = `FILTER / ${state.filterQuery || "type to narrow"} · Enter apply · Esc clear`;
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
    selectedIndex: 0,
    panelIndex: 0,
    panelCount: PANELS.length,
    motion: preferences.reducedMotion !== true,
    exitRequested: false,
    filterEditing: false,
    filterQuery: "",
    frame: 0,
    notice: null,
    confirmation: null
  };
  let previousScreen = null;
  let firstRender = true;

  function visibleSnapshot() {
    return filteredSnapshot(snapshot, ui.filterQuery);
  }

  function clampSelection() {
    const lanes = visibleSnapshot().lanes;
    ui.laneCount = lanes.length;
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
      frame
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
      return;
    }
    try {
      await runtime[method](lane, ...args);
      setNotice(`${method}-requested · ${lane.id}`);
    } catch (error) {
      setNotice(actionFailure(error));
    }
  }

  async function confirmCancellation() {
    const lane = selectedLane();
    if (!lane || ui.confirmation?.laneId !== lane.id) {
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
    await runRuntimeAction("cancel", lane, { confirmed: true });
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
    const firstLaneRow = terminal.columns >= 120 ? 9 : terminal.columns >= 80 ? 6 : 5;
    const index = Math.floor((event.row - firstLaneRow) / 2);
    if (event.row >= firstLaneRow && index >= 0 && index < ui.laneCount) {
      ui.selectedIndex = index;
      ui.notice = null;
    }
  }

  async function dispatch(event) {
    if (!event || typeof event !== "object") return { exit: false };
    if (event.type === "tick") {
      if (typeof readSnapshot === "function") {
        try {
          snapshot = normalizeSnapshot(await readSnapshot(), options.cwd);
        } catch {
          setNotice("state-read-failed");
        }
      }
      if (ui.motion && ACTIVE_STATUSES.has(selectedLane()?.status)) ui.frame += 1;
    } else if (event.type === "filter") {
      ui.filterEditing = true;
      ui.notice = null;
    } else if (event.type === "text" && ui.filterEditing) {
      ui.filterQuery = `${ui.filterQuery}${event.value}`.slice(0, MAX_FILTER_LENGTH);
      ui.selectedIndex = 0;
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
      ui.panelIndex = PANELS.indexOf("controls");
      ui.notice = null;
    } else if (event.type === "activate") {
      ui.panelIndex = PANELS.indexOf("detail");
      ui.notice = null;
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
      else if (lane) await runRuntimeAction("followUp", lane);
    } else if (event.type === "cancel") {
      const lane = selectedLane();
      if (lane) {
        ui.confirmation = { action: "cancel", laneId: lane.id };
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
    } else {
      ui = { ...ui, ...reduceInput(ui, event) };
      if (["move", "cyclePanel", "toggleMotion"].includes(event.type)) ui.notice = null;
    }
    await renderCurrent();
    return { exit: ui.exitRequested, textMode: ui.filterEditing };
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

      function enqueue(events) {
        for (const event of events) {
          queue = queue.then(async () => {
            if (finished) return;
            const result = await controller.dispatch(event);
            decoder.setTextMode(result.textMode === true);
            if (result.exit) finish();
          });
        }
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
        enqueue(decoder.push(chunk));
        scheduleEscapeFlush();
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
