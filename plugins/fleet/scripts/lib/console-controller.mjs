import { createInboxView, INBOX_COMMAND } from "./inbox-view.mjs";
import { deriveKiteSignal, kiteIsAnimated } from "./kite-companion.mjs";
import { normalizeConsoleView, sortConsoleLanes } from "./console-preferences.mjs";
import { companionItems, paletteItems, renderOperatorOverlay } from "./console-overlay.mjs";
import { StringDecoder } from "node:string_decoder";
import { buildLaneNavigation, GROUP_MODES } from "./lane-navigation.mjs";

import { authorizeAction } from "./authority.mjs";
import { createInputDecoder, reduceInput } from "./tui-input.mjs";
import { buildViewModel, renderScreen } from "./tui-render.mjs";
import { withTerminalSession } from "./tui-session.mjs";

const PANELS = Object.freeze(["detail", "evidence", "authority"]);
const CANCELLABLE_STATUSES = new Set(["queued", "starting", "running"]);
const MAX_FILTER_LENGTH = 256;
const MAX_COMPOSER_LENGTH = 4_096;
export const CONSOLE_TICK_MS = 250;
export const SNAPSHOT_REFRESH_TIMEOUT_MS = 750;
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


function safeTerminal(value = {}) {
  return {
    columns: Number.isInteger(value.columns) ? Math.max(1, value.columns) : 80,
    rows: Number.isInteger(value.rows) ? Math.max(1, value.rows) : 24
  };
}

function boundedStatus(value, width) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
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
    message = `SEARCH LANES › ${state.filterQuery || "type to filter"}_ · MATCHES ${state.matchedLaneCount}/${state.totalLaneCount} · Enter: Keep · Esc: Clear`;
  } else if (state.filterQuery) {
    message = `SEARCH LANES › ${state.filterQuery} · MATCHES ${state.matchedLaneCount}/${state.totalLaneCount} · /: Edit or clear`;
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
  const refreshTimeoutMs = Number.isInteger(options.refreshTimeoutMs)
    ? Math.max(1, options.refreshTimeoutMs)
    : SNAPSHOT_REFRESH_TIMEOUT_MS;
  let snapshot = normalizeSnapshot(options.snapshot, options.cwd);
  let terminal = safeTerminal(options.terminal);
  const initialCapacity = Math.max(1, Math.floor(Math.max(4, terminal.rows - 7) / 2));
  const restored = normalizeConsoleView(options.savedViewState?.current);
  let savedViews = [...(options.savedViewState?.savedViews ?? [])];
  let preferencesDirty = false;
  let ui = {
    laneCount: snapshot.lanes.length,
    totalLaneCount: snapshot.lanes.length,
    selectedIndex: 0,
    selectedLaneId: restored.selectedLaneId ?? snapshot.lanes[0]?.id ?? null,
    viewportOffset: 0,
    visibleLaneCapacity: initialCapacity,
    panelIndex: 0,
    panelCount: PANELS.length,
    motion: preferences.reducedMotion !== true && restored.motion,
    exitRequested: false,
    filterEditing: false,
    filterQuery: restored.filterQuery,
    groupMode: restored.groupMode,
    scope: restored.scope,
    sort: restored.sort,
    mascot: restored.mascot,
    favorites: restored.favorites,
    overlay: null,
    matchedLaneCount: snapshot.lanes.length,
    frame: 0,
    notice: options.preferenceWarning ?? null,
    confirmation: null,
    composer: null,
    session: null,
    refreshTick: 0,
    refreshInFlight: false,
    observation: options.initialObservation === "stale" ? "stale" : "fresh"
  };
  let previousScreen = null;
  let firstRender = true;
  let refreshGeneration = 0;
  let collapsedGroups = new Set(restored.collapsedGroups);
  let navigationCache = null;
  let sessionGeneration = 0;
  let sessionRead = null;
  let disposed = false;
  const extraCommands = [...(options.extraCommands ?? []), ...(typeof runtime.inboxList === "function" ? [INBOX_COMMAND] : [])];
  const inbox = createInboxView({ runtime, onChange: () => { void renderCurrent().catch(() => undefined); } });

  function navigation() {
    if (!navigationCache || navigationCache.snapshot !== snapshot
      || navigationCache.query !== ui.filterQuery || navigationCache.mode !== ui.groupMode
      || navigationCache.collapsed !== collapsedGroups || navigationCache.sort !== ui.sort || navigationCache.favorites !== ui.favorites) {
      navigationCache = { snapshot, query: ui.filterQuery, mode: ui.groupMode,
        collapsed: collapsedGroups, sort: ui.sort, favorites: ui.favorites, value: buildLaneNavigation(sortConsoleLanes(snapshot.lanes, ui.sort, ui.favorites), {
          query: ui.filterQuery, mode: ui.groupMode, collapsed: collapsedGroups
        }) };
    }
    return navigationCache.value;
  }

  function visibleSnapshot() { return { ...snapshot, scope: ui.scope, lanes: navigation().lanes }; }
  function selectedRow() { return navigation().rows[ui.selectedIndex] ?? null; }

  function toggleGroup() {
    const row = selectedRow();
    const id = row?.kind === "group" ? row.id : row?.parentId;
    if (!id) return;
    collapsedGroups = new Set(collapsedGroups);
    if (collapsedGroups.has(id)) collapsedGroups.delete(id);
    else collapsedGroups.add(id);
    ui.selectedLaneId = id;
    ui.confirmation = null;
  }

  function clampSelection() {
    const lanes = navigation().rows;
    ui.matchedLaneCount = navigation().lanes.length;
    ui.laneCount = lanes.length;
    ui.totalLaneCount = snapshot.lanes.length;
    ui.visibleLaneCapacity = Math.max(
      1,
      Math.floor(Math.max(4, terminal.rows - 7) / 2)
    );
    if (lanes.length === 0) {
      ui.selectedIndex = 0;
      ui.selectedLaneId = null;
      ui.viewportOffset = 0;
      return;
    }
    const preservedIndex = lanes.findIndex((lane) => lane.id === ui.selectedLaneId);
    ui.selectedIndex = preservedIndex >= 0
      ? preservedIndex
      : Math.max(0, Math.min(ui.selectedIndex, lanes.length - 1));
    ui.selectedLaneId = lanes[ui.selectedIndex]?.id ?? null;
    const capacity = Math.min(ui.visibleLaneCapacity, lanes.length);
    const maximumOffset = Math.max(0, lanes.length - capacity);
    ui.viewportOffset = Math.max(0, Math.min(ui.viewportOffset, maximumOffset));
    if (ui.selectedIndex < ui.viewportOffset) ui.viewportOffset = ui.selectedIndex;
    if (ui.selectedIndex >= ui.viewportOffset + capacity) {
      ui.viewportOffset = ui.selectedIndex - capacity + 1;
    }
  }

  function selectedLane() {
    clampSelection();
    const row = selectedRow();
    return row?.kind === "group" ? null : row;
  }

  async function renderCurrent() {
    if (disposed) return false;
    clampSelection();
    const lane = selectedLane();
    const view = buildViewModel(
      visibleSnapshot(),
      ui.selectedLaneId,
      PANELS[ui.panelIndex],
      {
        viewportOffset: ui.viewportOffset,
        visibleLaneCapacity: ui.visibleLaneCapacity,
        observation: ui.observation,
        navigationRows: ui.groupMode === "flat" ? undefined : navigation().rows
      }
    );
    const frame = ui.frame;
    const screen = inbox.view() ? inbox.render(terminal) : ui.overlay ? renderOperatorOverlay(ui.overlay, terminal, { savedViews, extraCommands, view, preferences: { ...preferences, motion: ui.motion, mascot: ui.mascot, frame } }) : decorateFooter(render(view, terminal, {
      ...preferences,
      motion: ui.motion,
      mascot: ui.mascot,
      scope: ui.scope,
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
    if (lane?.controlAvailable === false && method !== "session") {
      setNotice("OBSERVATION ONLY · Control remains with the owning Codex client");
      return false;
    }
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

  function invalidateSessionRead() {
    sessionGeneration += 1;
    if (sessionRead?.timer) clearTimeout(sessionRead.timer);
    sessionRead = null;
  }

  async function refreshSession() {
    if (!ui.session || sessionRead || disposed) return false;
    const laneId = ui.session.laneId;
    const lane = snapshot.lanes.find((candidate) => candidate.id === laneId);
    if (!lane || typeof runtime.session !== "function") {
      ui.session = { ...ui.session, loading: false, error: lane ? "Runtime thread inspection is unavailable." : "Lane is no longer available." };
      return false;
    }
    const read = { generation: sessionGeneration, timer: null, expired: false };
    sessionRead = read;
    const current = () => !disposed && read.generation === sessionGeneration && ui.session?.laneId === laneId;
    read.timer = setTimeout(() => {
      read.expired = true;
      if (current()) {
        ui.session = { ...ui.session, loading: false, error: "Session read timed out; transcript is stale. Navigation remains available." };
        void renderCurrent();
      }
    }, refreshTimeoutMs);
    read.timer.unref?.();
    // Do not await a remote transcript on the input queue. Keep one underlying
    // read in flight even after the UI deadline to avoid a timeout retry storm.
    Promise.resolve().then(() => runtime.session(lane)).then((session) => {
      if (!current() || read.expired) return;
      ui.session = { ...session, laneId, loading: false, error: null,
        scroll: ui.session.scroll ?? 0, activityExpanded: ui.session.activityExpanded === true };
    }, (error) => {
      if (current()) ui.session = { ...ui.session, loading: false, error: boundedStatus(error?.message ?? "Session read failed.", 160) };
    }).finally(() => {
      clearTimeout(read.timer);
      if (sessionRead === read) sessionRead = null;
      if (current()) void renderCurrent();
    });
    return true;
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
    invalidateSessionRead();
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
    ui.composer = lane.controlAvailable === false ? null : { laneId: lane.id, value: "" };
    await renderCurrent();
    await refreshSession();
  }

  function closeSession() {
    invalidateSessionRead();
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
    const identifier = String(lane.id).slice(0, 320);
    const encoded = Buffer.from(identifier, "utf8").toString("base64");
    writeControl(`\u001b]52;c;${encoded}\u0007`);
    setNotice(`COPY ${identifier} · OSC 52 sent; identifier remains visible here`);
  }

  function selectMouseRow(event) {
    if (ui.mascot && event.row === 1 && event.column >= Math.max(1, terminal.columns - 14)) {
      ui.overlay = { kind: "kite", query: "", index: 0 }; ui.confirmation = null;
      return;
    }
    const firstLaneRow = 6;
    const visibleIndex = Math.floor((event.row - firstLaneRow) / 2);
    const index = ui.viewportOffset + visibleIndex;
    if (event.row >= firstLaneRow && visibleIndex >= 0 && index < ui.laneCount) {
      ui.selectedIndex = index;
      ui.selectedLaneId = navigation().rows[index]?.id ?? null;
      ui.notice = null;
    }
  }

  function startSnapshotRefresh(force = false) {
    if (typeof readSnapshot !== "function" || ui.refreshInFlight) return;
    ui.refreshInFlight = true;
    const generation = ++refreshGeneration;
    let timer = null;
    let read;
    try {
      read = readSnapshot({ scope: ui.scope, force });
    } catch {
      read = Promise.reject(new Error("state-read-failed"));
    }
    const outcome = Promise.race([
      Promise.resolve(read).then(
        (value) => ({ state: "fresh", value }),
        () => ({ state: "stale" })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: "stale" }), refreshTimeoutMs);
      })
    ]);
    outcome.then((result) => {
      if (generation !== refreshGeneration) return;
      if (timer !== null) clearTimeout(timer);
      if (result.state === "fresh") {
        snapshot = normalizeSnapshot(result.value, options.cwd);
        ui.observation = "fresh";
        clampSelection();
      } else {
        ui.observation = "stale";
      }
    }).finally(() => {
      if (generation !== refreshGeneration) return;
      ui.refreshInFlight = false;
      renderCurrent().catch(() => undefined);
    });
  }

  function captureView() {
    return normalizeConsoleView({ ...ui, collapsedGroups: [...collapsedGroups] });
  }

  async function saveState() {
    if (!preferencesDirty || typeof options.saveViewState !== "function") return;
    await options.saveViewState({ schemaVersion: 1, current: captureView(), savedViews });
    preferencesDirty = false;
  }

  function changeScope(scope) {
    // Invalidate late reads before swapping scope; never act on rows from a previous scope.
    refreshGeneration += 1;
    invalidateSessionRead();
    ui.refreshInFlight = false;
    snapshot = { ...defaultSnapshot(options.cwd), scope, lanes: [] };
    ui.scope = scope;
    ui.selectedIndex = 0; ui.selectedLaneId = null; ui.viewportOffset = 0;
    ui.session = null; ui.composer = null; ui.confirmation = null;
    ui.groupMode = scope === "projects" ? "project" : scope === "native" ? "parent" : "flat";
    ui.observation = "stale";
    startSnapshotRefresh(true);
  }

  async function runOperatorCommand(id) {
    ui.overlay = null;
    if (id === "inbox") { ui.confirmation = null; inbox.open(selectedLane()); }
    else if (id === "kite") ui.overlay = { kind: "kite", query: "", index: 0 };
    else if (id.startsWith("scope:")) changeScope(id.slice(6));
    else if (id === "refresh") startSnapshotRefresh(true);
    else if (id === "attention") ui.sort = "attention";
    else if (id.startsWith("sort:")) ui.sort = id.slice(5);
    else if (id === "favorite") {
      const lane = selectedLane();
      if (lane) ui.favorites = ui.favorites.includes(lane.id) ? ui.favorites.filter((item) => item !== lane.id) : [...ui.favorites.slice(-127), lane.id];
    } else if (id === "saveView") ui.overlay = { kind: "saveView", query: "", index: 0 };
    else if (id === "toggleMascot") ui.mascot = !ui.mascot;
    else if (id === "toggleMotion") {
      if (preferences.reducedMotion !== true) ui.motion = !ui.motion;
    } else if (id === "clear") { ui.filterQuery = ""; collapsedGroups = new Set(); }
    else if (id.startsWith("view:")) {
      const saved = savedViews.find((view) => view.name === id.slice(5));
      if (saved) {
        changeScope(saved.view.scope);
        Object.assign(ui, normalizeConsoleView(saved.view));
        if (preferences.reducedMotion === true) ui.motion = false;
        collapsedGroups = new Set(saved.view.collapsedGroups);
      }
    } else if (typeof options.onOperatorCommand === "function") {
      await options.onOperatorCommand(id, selectedLane());
    }
    preferencesDirty = true;
    if (!ui.overlay) setNotice(`VIEW ${ui.scope.toUpperCase()} · ${ui.sort.toUpperCase()} · : Commands`);
  }

  async function dispatchOverlay(event) {
    const overlay = ui.overlay;
    const items = () => overlay.kind === "kite" ? companionItems({ extraCommands }) : paletteItems(overlay.query, savedViews, extraCommands);
    if (["quit", "closeSession", "clearFilter", "discardMessage"].includes(event.type)) ui.overlay = null;
    else if (event.type === "text" && overlay.kind !== "kite") { overlay.query = `${overlay.query}${event.value}`.slice(0, overlay.kind === "saveView" ? 48 : 256); overlay.index = 0; }
    else if (event.type === "backspace") { overlay.query = Array.from(overlay.query).slice(0, -1).join(""); overlay.index = 0; }
    else if (event.type === "move") overlay.index = Math.max(0, Math.min(items().length - 1, overlay.index + event.delta));
    else if (["activate", "applyFilter", "submitMessage"].includes(event.type)) {
      if (overlay.kind === "saveView") {
        const name = overlay.query.trim();
        if (!name) setNotice("View name is empty.");
        else if (savedViews.some((saved) => saved.name === name)) setNotice("View name already exists; choose a different name.");
        else if (savedViews.length >= 16) setNotice("Saved-view limit reached (16).");
        else {
          savedViews.push({ name, view: captureView() }); preferencesDirty = true;
          try { await saveState(); ui.overlay = null; setNotice(`VIEW SAVED · ${name}`); }
          catch (error) { setNotice(error.message); }
        }
      } else {
        const item = items()[overlay.index];
        if (item) await runOperatorCommand(item.id);
      }
    } else if (event.type === "resize") terminal = safeTerminal(event);
  }

  async function dispatch(event) {
    if (!event || typeof event !== "object") return { exit: false };
    if (inbox.view()) {
      if (event.type === "resize") terminal = safeTerminal(event);
      inbox.handle(event); await renderCurrent();
      return { exit: false, textMode: inbox.view() ? "palette" : ui.composer ? "composer" : ui.filterEditing ? "filter" : false };
    }
    if (ui.overlay && event.type !== "tick") {
      await dispatchOverlay(event);
      await renderCurrent();
      return { exit: false, textMode: inbox.view() || ui.overlay ? "palette" : ui.composer ? "composer" : ui.filterEditing ? "filter" : false };
    }
    if (event.type !== "tick") preferencesDirty = true;
    if (event.type === "tick") {
      ui.refreshTick += 1;
      startSnapshotRefresh();
      await Promise.resolve();
      const activityView = { lanes: snapshot.lanes, selectedLane: selectedLane(), observation: ui.observation };
      if (kiteIsAnimated(deriveKiteSignal(activityView), { ...preferences, motion: ui.motion, mascot: ui.mascot }) && !ui.session && (!ui.overlay || ui.overlay.kind === "kite")) ui.frame += 1;
      if (ui.session && ui.refreshTick % 4 === 0 && !ui.composer?.value) {
        await refreshSession();
      }
    } else if (event.type === "inbox" && !ui.session && !ui.filterEditing) {
      inbox.open(selectedLane()); ui.confirmation = null;
    } else if (event.type === "kite" && !ui.session && !ui.filterEditing) {
      ui.overlay = { kind: "kite", query: "", index: 0 }; ui.confirmation = null;
    } else if (event.type === "palette" && !ui.session && !ui.filterEditing) {
      ui.overlay = { kind: "palette", query: "", index: 0 }; ui.confirmation = null;
    } else if (event.type === "scope" && !ui.session && !ui.filterEditing) {
      const scopes = ["workspace", "projects", "native"];
      await runOperatorCommand(`scope:${scopes[(scopes.indexOf(ui.scope) + 1) % scopes.length]}`);
    } else if (event.type === "attention" && !ui.session) {
      await runOperatorCommand("attention");
    } else if (event.type === "favorite" && !ui.session) {
      await runOperatorCommand("favorite");
    } else if (event.type === "closeSession" || (event.type === "quit" && ui.session?.observationOnly)) {
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
      ui.selectedLaneId = null;
      ui.viewportOffset = 0;
    } else if (event.type === "backspace" && ui.composer) {
      ui.composer.value = Array.from(ui.composer.value).slice(0, -1).join("");
    } else if (event.type === "backspace" && ui.filterEditing) {
      ui.filterQuery = Array.from(ui.filterQuery).slice(0, -1).join("");
      ui.selectedIndex = 0;
      ui.selectedLaneId = null;
      ui.viewportOffset = 0;
    } else if (event.type === "applyFilter" && ui.filterEditing) {
      ui.filterEditing = false;
      setNotice(ui.filterQuery ? `FILTER ACTIVE · ${ui.filterQuery}` : "FILTER CLEARED");
    } else if (event.type === "clearFilter") {
      ui.filterEditing = false;
      ui.filterQuery = "";
      ui.selectedLaneId = null;
      ui.selectedIndex = 0;
      ui.viewportOffset = 0;
      setNotice("FILTER CLEARED");
    } else if (event.type === "help") {
      setNotice(
        "FLEET CONTROLS · ↑↓ select · PgUp/PgDn page · Home/End jump · Enter open agent · Tab change view · / search · G groups · Space fold · [/] all · X cancel · Ctrl+G return"
      );
    } else if (event.type === "groupMode" && !ui.session && !ui.filterEditing) {
      ui.groupMode = GROUP_MODES[(GROUP_MODES.indexOf(ui.groupMode) + 1) % GROUP_MODES.length];
      ui.confirmation = null;
      setNotice(`GROUP ${ui.groupMode.toUpperCase()} · G cycle · Space fold · [ collapse all · ] expand all`);
    } else if (event.type === "toggleGroup" && !ui.session && !ui.filterEditing) {
      toggleGroup();
    } else if (["collapseGroups", "expandGroups"].includes(event.type) && !ui.session && !ui.filterEditing) {
      collapsedGroups = event.type === "collapseGroups"
        ? new Set(navigation().groups.map((group) => group.id)) : new Set();
      ui.selectedLaneId = null;
      ui.selectedIndex = 0;
      ui.viewportOffset = 0;
      ui.confirmation = null;
    } else if (event.type === "activate") {
      if (selectedRow()?.kind === "group") toggleGroup();
      else await openSession();
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
    } else if (["move", "page", "home", "end"].includes(event.type)) {
      if (ui.laneCount <= 1) {
        setNotice(`ONLY ${ui.laneCount} LANE · selection unchanged`);
      } else {
        ui = { ...ui, ...reduceInput(ui, event) };
        ui.selectedLaneId = navigation().rows[ui.selectedIndex]?.id ?? null;
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
      textMode: inbox.view() || ui.overlay ? "palette" : ui.composer ? "composer" : ui.filterEditing ? "filter" : false
    };
  }

  return Object.freeze({
    dispatch,
    dispose() { disposed = true; inbox.dispose(); refreshGeneration += 1; invalidateSessionRead(); },
    render: renderCurrent,
    saveState,
    viewState: () => ({ schemaVersion: 1, current: captureView(), savedViews: structuredClone(savedViews) }),
    state: () => Object.freeze({ ...ui, inbox: inbox.view() })
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

async function readInitialSnapshot(readSnapshot, cwd, timeoutMs, clock) {
  let timer = null;
  let read;
  try {
    read = readSnapshot();
  } catch {
    return { snapshot: defaultSnapshot(cwd), observation: "stale" };
  }
  const schedule = clock.setTimeout ?? setTimeout;
  const cancel = clock.clearTimeout ?? clearTimeout;
  const outcome = await Promise.race([
    Promise.resolve(read).then(
      (value) => ({ snapshot: value, observation: "fresh" }),
      () => ({ snapshot: defaultSnapshot(cwd), observation: "stale" })
    ),
    new Promise((resolve) => {
      timer = schedule(() => resolve({
        snapshot: defaultSnapshot(cwd),
        observation: "stale"
      }), timeoutMs);
    })
  ]);
  if (timer !== null) cancel(timer);
  return outcome;
}

export async function runConsole(options = {}) {
  const io = options.io ?? { stdin: process.stdin, stdout: process.stdout, lifecycle: process };
  const clock = options.clock ?? defaultClock();
  const terminalSession = options.terminalSession ?? withTerminalSession;
  const readSnapshot = options.readSnapshot ?? (async () => defaultSnapshot(options.cwd));
  const refreshTimeoutMs = Number.isInteger(options.refreshTimeoutMs)
    ? Math.max(1, options.refreshTimeoutMs)
    : SNAPSHOT_REFRESH_TIMEOUT_MS;
  const initial = options.snapshot
    ? { snapshot: options.snapshot, observation: "fresh" }
    : await readInitialSnapshot(() => readSnapshot({ scope: options.savedViewState?.current?.scope ?? "workspace" }), options.cwd, refreshTimeoutMs, clock);

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
      snapshot: initial.snapshot,
      initialObservation: initial.observation,
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
    let tickQueued = false;

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
        controller.dispose();
        Promise.resolve(controller.saveState()).then(() => {
          if (error) reject(error);
          else resolve({ exitReason: signal?.aborted ? "signal" : "return" });
        }, (saveError) => reject(error ?? saveError));
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
      const tick = events.length === 1 && events[0].type === "tick";
      if (tick && tickQueued) return; // Render ticks cannot pile up behind a slow command.
      if (tick) tickQueued = true;
      queue = queue.then(() => dispatchEvents(events)).finally(() => { if (tick) tickQueued = false; });
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
