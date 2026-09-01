import { STATUS_PRESENTATION, createTheme } from "./theme.mjs";

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const PANELS = new Set(["detail", "evidence", "authority"]);
const MOTION_STATUSES = new Set(["queued", "running", "complete"]);
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null;

const BORDERS = Object.freeze({
  unicode: { vertical: "│", horizontal: "─", signal: "━", selected: "▌", arrow: "▶" },
  ascii: { vertical: "|", horizontal: "-", signal: "=", selected: ">", arrow: ">" }
});

const STATUS_EXPLANATIONS = Object.freeze({
  queued: "Waiting for a scheduler slot.",
  running: "Work is in progress.",
  complete: "Worker claim; independent verification has not passed.",
  verified: "Independent evidence has passed verification.",
  blocked: "Progress needs an input or capability that is not available.",
  failed: "The lane stopped without a usable result.",
  cancelled: "The owned lane turn was cancelled.",
  interrupted: "The supervisor ended; controller reconciliation is required before retry.",
  outcome_unknown: "An external effect is unresolved; blind retry is blocked."
});

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemes(value) {
  const plain = stripAnsi(value);
  if (!segmenter) return Array.from(plain);
  return Array.from(segmenter.segment(plain), ({ segment }) => segment);
}

function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x200d || codePoint === 0xfe0f || /\p{Mark}/u.test(character)) continue;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    return isWideCodePoint(codePoint) ? 2 : 1;
  }
  return 0;
}

export function displayWidth(value) {
  return graphemes(value).reduce((total, item) => total + graphemeWidth(item), 0);
}

function truncate(value, width, ellipsis = "…") {
  const target = Math.max(0, width);
  if (displayWidth(value) <= target) return String(value);
  if (target === 0) return "";
  const marker = displayWidth(ellipsis) <= target ? ellipsis : "";
  const limit = target - displayWidth(marker);
  let output = "";
  let used = 0;
  for (const item of graphemes(value)) {
    const itemWidth = graphemeWidth(item);
    if (used + itemWidth > limit) break;
    output += item;
    used += itemWidth;
  }
  return `${output}${marker}`;
}

function pad(value, width) {
  const clipped = truncate(String(value ?? ""), width);
  return `${clipped}${" ".repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function wrap(value, width) {
  const target = Math.max(1, width);
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    if (displayWidth(word) > target) {
      if (current) lines.push(current);
      lines.push(truncate(word, target));
      current = "";
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= target) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function boundedText(value, fallback, maximum = 160) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.slice(0, maximum).replace(/[\u0000-\u001f\u007f]/g, " ");
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const fields = ["input", "output", "total"];
  const usage = {};
  for (const field of fields) {
    if (Number.isFinite(value[field]) && value[field] >= 0) usage[field] = value[field];
  }
  return Object.keys(usage).length > 0 ? Object.freeze(usage) : null;
}

function normalizeAuthority(value = {}) {
  const browser = value.browser ?? {};
  const processAuthority = value.process ?? {};
  const database = value.database ?? {};
  const imageAuthority = value.image ?? {};
  const external = value.externalEffects ?? {};
  return Object.freeze({
    sandbox: value.sandbox === "workspace-write" ? "workspace-write" : "read-only",
    network: value.network === "live" ? "live" : "off",
    browser: Object.freeze({ inspect: browser.inspect === true, mutate: browser.mutate === true }),
    process: Object.freeze({
      start: processAuthority.start === true,
      stopOwned: processAuthority.stopOwned === true
    }),
    database: Object.freeze({ read: database.read === true, write: database.write === true }),
    image: Object.freeze({
      generate: imageAuthority.generate === true,
      edit: imageAuthority.edit === true
    }),
    externalEffects: Object.freeze({
      send: external.send === true,
      payment: external.payment === true,
      deploy: external.deploy === true,
      delete: external.delete === true
    }),
    retry: value.retry === true
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function normalizeLane(value, index) {
  const status = STATUS_PRESENTATION[value?.status] ? value.status : "blocked";
  return {
    id: boundedText(value?.id, `lane-${index + 1}`, 64),
    role: boundedText(value?.role, "unreported-role", 64),
    label: boundedText(value?.label, "Untitled lane", 120),
    model: boundedText(value?.model, "Model not reported", 80),
    effort: boundedText(value?.effort, "Effort not reported", 32),
    status,
    phase: boundedText(value?.phase, status, 80),
    authority: normalizeAuthority(value?.authority),
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
    resultRef: typeof value?.resultRef === "string" ? value.resultRef : null,
    verifierLaneId: typeof value?.verifierLaneId === "string" ? value.verifierLaneId : null,
    evidenceRefs: Array.isArray(value?.evidenceRefs)
      ? value.evidenceRefs.filter((item) => typeof item === "string").slice(0, 32)
      : [],
    outcome: typeof value?.outcome === "string" ? boundedText(value.outcome, "unknown", 64) : null,
    workPerformed: Array.isArray(value?.workPerformed)
      ? value.workPerformed.filter((item) => typeof item === "string").slice(0, 32)
      : [],
    verification: Array.isArray(value?.verification)
      ? value.verification.filter((item) => typeof item === "string").slice(0, 32)
      : [],
    artifactRefs: Array.isArray(value?.artifactRefs)
      ? value.artifactRefs.filter((item) => typeof item === "string").slice(0, 64)
      : [],
    controllerRequest: value?.controllerRequest && typeof value.controllerRequest === "object"
      ? {
        kind: boundedText(value.controllerRequest.kind, "runtime_blocker", 64),
        question: boundedText(
          value.controllerRequest.question,
          "Controller attention required",
          512
        )
      }
      : null,
    stopReason: typeof value?.stopReason === "string"
      ? boundedText(value.stopReason, "Lane stopped", 512)
      : null,
    pendingContinuation: value?.pendingContinuation
      && typeof value.pendingContinuation === "object"
      ? {
        state: boundedText(value.pendingContinuation.state, "outcome_unknown", 64),
        previousTurnId: typeof value.pendingContinuation.previousTurnId === "string"
          ? boundedText(value.pendingContinuation.previousTurnId, "unknown", 128)
          : null
      }
      : null,
    automaticContinuations: Number.isSafeInteger(value?.automaticContinuations)
      ? Math.max(0, value.automaticContinuations)
      : 0,
    events: Array.isArray(value?.events)
      ? value.events.filter((item) => typeof item === "string").slice(-8)
      : [],
    tokenUsage: normalizeUsage(value?.tokenUsage)
  };
}

export function buildViewModel(snapshot, selection, panel = "detail", viewport = {}) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const lanes = Array.isArray(source.lanes) ? source.lanes.map(normalizeLane) : [];
  const selectedIndex = typeof selection === "number"
    ? Math.max(0, Math.min(lanes.length - 1, selection))
    : Math.max(0, lanes.findIndex((lane) => lane.id === selection));
  const selectedLane = lanes[selectedIndex] ?? null;
  const visibleLaneCapacity = Number.isInteger(viewport.visibleLaneCapacity)
    ? Math.max(1, viewport.visibleLaneCapacity)
    : Math.max(1, lanes.length);
  const maximumOffset = Math.max(0, lanes.length - visibleLaneCapacity);
  let viewportOffset = Number.isInteger(viewport.viewportOffset)
    ? Math.max(0, Math.min(viewport.viewportOffset, maximumOffset))
    : 0;
  if (selectedIndex < viewportOffset) viewportOffset = selectedIndex;
  if (selectedIndex >= viewportOffset + visibleLaneCapacity) {
    viewportOffset = selectedIndex - visibleLaneCapacity + 1;
  }
  viewportOffset = Math.max(0, Math.min(viewportOffset, maximumOffset));
  const visibleLanes = lanes.slice(viewportOffset, viewportOffset + visibleLaneCapacity);
  const totals = Object.fromEntries(Object.keys(STATUS_PRESENTATION).map((status) => [
    status,
    lanes.filter((lane) => lane.status === status).length
  ]));
  totals.active = totals.queued + totals.running;
  totals.attention = totals.blocked + totals.failed + totals.interrupted + totals.outcome_unknown;

  return deepFreeze({
    workspace: {
      name: boundedText(source.workspace?.name, "local-workspace", 80),
      branch: boundedText(source.workspace?.branch, "branch-not-reported", 80)
    },
    runtime: {
      health: boundedText(source.runtime?.health, "unknown", 32),
      protocol: boundedText(source.runtime?.protocol, "unknown", 32),
      activeLimit: Number.isInteger(source.runtime?.activeLimit)
        ? source.runtime.activeLimit
        : null
    },
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
    lanes,
    visibleLanes,
    visibleLaneCapacity,
    viewportOffset,
    observation: ["loading", "stale"].includes(viewport.observation)
      ? viewport.observation
      : "fresh",
    selectedIndex,
    selectedLane,
    totals,
    panel: PANELS.has(panel) ? panel : "detail"
  });
}

function statusText(status, useUnicode) {
  const presentation = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.blocked;
  const mark = useUnicode ? presentation.unicode : presentation.ascii;
  return `${mark} ${presentation.label}`;
}

function formatNumber(value) {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function usageText(usage) {
  if (!usage) return "Token usage not reported";
  const parts = [];
  if (Number.isFinite(usage.input)) parts.push(`${formatNumber(usage.input)} in`);
  if (Number.isFinite(usage.output)) parts.push(`${formatNumber(usage.output)} out`);
  const total = Number.isFinite(usage.total)
    ? usage.total
    : (usage.input ?? 0) + (usage.output ?? 0);
  const prefix = parts.length > 0 ? `${formatNumber(total)} tokens · ` : "";
  return `${prefix}${parts.join(" / ") || `${formatNumber(total)} tokens`}`;
}

function laneLines(view, width, useUnicode) {
  if (view.lanes.length === 0) return ["No lanes yet", "Start a bounded lane from Claude Code."];
  const lines = [];
  view.visibleLanes.forEach((lane, visibleIndex) => {
    const index = view.viewportOffset + visibleIndex;
    const selected = index === view.selectedIndex;
    const marker = selected ? BORDERS[useUnicode ? "unicode" : "ascii"].selected : " ";
    const number = String(index + 1).padStart(2, "0");
    const status = pad(statusText(lane.status, useUnicode), 17);
    lines.push(truncate(`${marker} ${number} ${status} ${lane.id}`, width));
    const metadata = `${lane.role} · ${lane.model}/${lane.effort}`;
    lines.push(truncate(`     ${metadata}`, width));
  });
  return lines;
}

function visibleRange(view) {
  if (view.lanes.length === 0) return "VISIBLE 0–0 / 0";
  const first = view.viewportOffset + 1;
  const last = view.viewportOffset + view.visibleLanes.length;
  return `VISIBLE ${first}–${last} / ${view.lanes.length}`;
}

function lanePanelLabel(view) {
  return view.visibleLanes.length < view.lanes.length
    ? `LANES ${view.lanes.length} · ${visibleRange(view)}`
    : `LANES  ${view.lanes.length}`;
}

function detailLines(lane, width) {
  if (!lane) return ["No lane selected"];
  const lines = [
    ...wrap(lane.label, width),
    "",
    `ROLE     ${lane.role}`,
    `PHASE    ${lane.phase}`,
    `MODEL    ${lane.model}`,
    `EFFORT   ${lane.effort}`,
    "",
    ...wrap(STATUS_EXPLANATIONS[lane.status], width),
    usageText(lane.tokenUsage),
  ];
  if (lane.phase.startsWith("recovering ")) {
    lines.push("", `AUTO RECOVERY ${lane.phase.slice("recovering ".length)}`);
  }
  if (lane.controllerRequest) {
    lines.push(
      "",
      `CONTROLLER REQUEST · ${lane.controllerRequest.kind}`,
      lane.controllerRequest.question
    );
  }
  if (lane.pendingContinuation) {
    lines.push(
      "",
      `CONTINUATION ${lane.pendingContinuation.state.toUpperCase()}`,
      "The previous terminal record is preserved until this continuation is reconciled."
    );
  }
  lines.push(
    "",
    "RESULT",
    lane.resultRef ?? "No result reference recorded",
    "",
    "SAFE EVENTS",
    ...(lane.events.length > 0 ? lane.events : ["No safe events recorded"])
  );
  return lines.flatMap((line) => wrap(line, width));
}

function evidenceLines(lane, width) {
  if (!lane) return ["No lane selected"];
  const lines = [
    `STATUS   ${STATUS_PRESENTATION[lane.status].label}`,
    ...(lane.outcome ? [`OUTCOME  ${lane.outcome}`] : []),
    `RESULT   ${lane.resultRef ?? "not recorded"}`,
    `VERIFIER ${lane.verifierLaneId ?? "not recorded"}`
  ];
  if (lane.workPerformed.length > 0) {
    lines.push("", "WORK PERFORMED");
    lane.workPerformed.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (lane.verification.length > 0) {
    lines.push("", "VERIFICATION");
    lane.verification.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (lane.artifactRefs.length > 0) {
    lines.push("", "ARTIFACT REFS");
    lane.artifactRefs.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  lines.push("", "EVIDENCE");
  if (lane.evidenceRefs.length === 0) lines.push("No evidence references recorded");
  else lane.evidenceRefs.forEach((reference, index) => lines.push(`${index + 1}. ${reference}`));
  return lines.flatMap((line) => wrap(line, width));
}

function grant(value) {
  return value ? "YES" : "--";
}

function authorityLines(lane, width) {
  if (!lane) return ["No lane selected"];
  const value = lane.authority;
  const lines = [
    `SANDBOX   ${value.sandbox.toUpperCase()}`,
    `NETWORK   ${value.network.toUpperCase()}`,
    "",
    `BROWSER   inspect ${grant(value.browser.inspect)}  mutate ${grant(value.browser.mutate)}`,
    `PROCESS   start ${grant(value.process.start)}  stop-owned ${grant(value.process.stopOwned)}`,
    `DATABASE  read ${grant(value.database.read)}  write ${grant(value.database.write)}`,
    `IMAGE     generate ${grant(value.image.generate)}  edit ${grant(value.image.edit)}`,
    `SEND      ${grant(value.externalEffects.send)}`,
    `PAYMENT   ${grant(value.externalEffects.payment)}`,
    `DEPLOY    ${grant(value.externalEffects.deploy)}`,
    `DELETE    ${grant(value.externalEffects.delete)}`,
    `RETRY     ${grant(value.retry)}`,
    "",
    "Roles do not grant authority."
  ];
  return lines.flatMap((line) => wrap(line, width));
}

function controlsLines(width) {
  const controls = [
    "↑/↓ or J/K   Select lane",
    "Enter or M   Open live Codex session",
    "Tab          Cycle dashboard panels",
    "/            Filter lanes",
    "X            Confirmed cancellation",
    "E            Open preserved editor",
    "P            Pause formation motion",
    "H, ? or F1   Contextual help",
    "Ctrl+G/Q/Esc Return to Claude Code"
  ];
  return controls.flatMap((line) => wrap(line, width));
}

function fitPanel(lines, height, width) {
  const result = lines.slice(0, height).map((line) => pad(line, width));
  while (result.length < height) result.push(" ".repeat(width));
  return result;
}

function joinPanels(panelGroups, widths, height, border) {
  const fitted = panelGroups.map((lines, index) => fitPanel(lines, height, widths[index]));
  return Array.from({ length: height }, (_, row) => (
    fitted.map((panel) => panel[row]).join(` ${border.vertical} `).trimEnd()
  ));
}

function summary(view) {
  const parts = [`${String(view.totals.active).padStart(2, "0")} LIVE`];
  if (view.totals.verified > 0) {
    parts.push(`${String(view.totals.verified).padStart(2, "0")} VERIFIED`);
  }
  if (view.totals.attention > 0) {
    parts.push(`${String(view.totals.attention).padStart(2, "0")} ATTENTION`);
  }
  return parts.join("  ");
}

const KITE_WIDTH = 21;
const KITE_ORBITS = Object.freeze([
  Object.freeze(["◆                 ◆", " ╲               ╱"]),
  Object.freeze(["  ◆             ◆", "   ╲╲         ╱╱"]),
  Object.freeze(["     ◆       ◆", "      ╲     ╱"]),
  Object.freeze(["  ◆             ◆", "   ╱╱         ╲╲"])
]);
const KITE_ASCII_ORBITS = Object.freeze([
  Object.freeze(["*                 *", " \\               /"]),
  Object.freeze(["  *             *", "   \\\\         //"]),
  Object.freeze(["     *       *", "      \\     /"]),
  Object.freeze(["  *             *", "   //         \\\\"])
]);

function center(value, width) {
  const clipped = truncate(value, width);
  const remaining = Math.max(0, width - displayWidth(clipped));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function kiteFeatures(status, frame, useUnicode) {
  if (!useUnicode) {
    const movingEyes = [["o", "o"], [".", "o"], ["-", "-"], ["o", "."]];
    const completeMouths = ["-", "~", "-", "~"];
    const completeCores = ["C", "*", "C", "+"];
    const states = {
      queued: [".", ".", "v", "Q"],
      running: [...movingEyes[frame], "v", "R"],
      complete: [...movingEyes[frame], completeMouths[frame], completeCores[frame]],
      verified: ["^", "^", "u", "V"],
      blocked: ["-", "-", "!", "!"],
      failed: ["x", "x", "-", "X"],
      cancelled: [".", ".", "-", "-"],
      interrupted: ["-", "-", "|", "I"],
      outcome_unknown: ["?", "?", ".", "?"]
    };
    return states[status] ?? states.blocked;
  }
  const movingEyes = [["●", "●"], ["•", "●"], ["─", "─"], ["●", "•"]];
  const completeMouths = ["─", "⌁", "─", "⌁"];
  const completeCores = ["◇", "◈", "◆", "◈"];
  const states = {
    queued: ["·", "·", "⌄", "○"],
    running: [...movingEyes[frame], "▿", "◆"],
    complete: [...movingEyes[frame], completeMouths[frame], completeCores[frame]],
    verified: ["⌒", "⌒", "⌣", "✓"],
    blocked: ["─", "─", "!", "!"],
    failed: ["×", "×", "─", "×"],
    cancelled: ["·", "·", "─", "–"],
    interrupted: ["─", "─", "│", "‖"],
    outcome_unknown: ["?", "?", "·", "?"]
  };
  return states[status] ?? states.blocked;
}

function formationFrame(preferences, length) {
  const moving = preferences.motion !== false && preferences.reducedMotion !== true;
  const requestedFrame = Number.isInteger(preferences.frame) ? preferences.frame : 0;
  return moving ? Math.abs(requestedFrame) % length : 2;
}

function postureFrame(status, preferences, length) {
  if (!MOTION_STATUSES.has(status)) return 2 % length;
  return formationFrame(preferences, length);
}

function motionLabel(preferences) {
  if (preferences.motion === false || preferences.reducedMotion === true) return "PAUSED ■";
  const frames = preferences.unicode === false ? ["|", "/", "-", "\\"] : ["◐", "◓", "◑", "◒"];
  return `LIVE ${frames[formationFrame(preferences, frames.length)]}`;
}

export function renderFleetMark(view, preferences = {}) {
  const useUnicode = preferences.unicode !== false;
  const orbits = useUnicode ? KITE_ORBITS : KITE_ASCII_ORBITS;
  const status = view?.selectedLane?.status ?? "queued";
  const frame = postureFrame(status, preferences, orbits.length);
  const [leftEye, rightEye, mouth, core] = kiteFeatures(status, frame, useUnicode);
  const body = useUnicode
    ? [
      `╭━━━╾▰  ${leftEye} ${rightEye}  ▰╼━━━╮`,
      `╰━╮     ${mouth}     ╭━╯`,
      `╰━━━╲  ${core}  ╱━━━╯`
    ]
    : [
      `[====  ${leftEye} ${rightEye}  ====]`,
      `\\        ${mouth}        /`,
      `\\===    ${core}    ===/`
    ];
  const posture = (
    status === "blocked"
    || status === "failed"
    || status === "interrupted"
    || status === "outcome_unknown"
  )
    ? [orbits[0][0], center("╲             ╱", KITE_WIDTH), ...body]
    : [...orbits[frame], ...body];
  return posture.map((line) => center(line, KITE_WIDTH));
}

function renderCompactMark(view, preferences = {}) {
  const useUnicode = preferences.unicode !== false;
  const status = view?.selectedLane?.status ?? "queued";
  const frame = postureFrame(status, preferences, 4);
  const [leftEye, rightEye, , core] = kiteFeatures(status, frame, useUnicode);
  return useUnicode
    ? `╭▰ ${leftEye} ${rightEye} ▰╮${core}`
    : `[= ${leftEye} ${rightEye} =]${core}`;
}

function placeRight(left, right, columns) {
  const rightBlock = truncate(right, columns);
  const visibleRight = rightBlock.trimEnd();
  const rightWidth = displayWidth(rightBlock);
  const leftLimit = Math.max(0, columns - rightWidth - 2);
  const clippedLeft = truncate(left, leftLimit);
  const gap = Math.max(0, columns - displayWidth(clippedLeft) - rightWidth);
  return `${clippedLeft}${" ".repeat(gap)}${visibleRight}`;
}

function versionLabel(preferences) {
  const value = typeof preferences.version === "string" ? preferences.version.trim() : "";
  return value && value !== "unknown" ? `v${truncate(value, 24)}  ` : "";
}

function wideMasthead(view, columns, preferences) {
  const mark = renderCompactMark(view, preferences);
  const limit = view.runtime.activeLimit === null ? "?" : String(view.runtime.activeLimit);
  const motion = motionLabel(preferences);
  return [
    placeRight(
      `FLEET//OPS  ${versionLabel(preferences)}${view.workspace.name}@${view.workspace.branch}  ${summary(view)}`,
      mark,
      columns
    ),
    `RUNTIME ${view.runtime.health.toUpperCase()} · PROTOCOL ${view.runtime.protocol.toUpperCase()} · ACTIVE LIMIT ${limit} · KITE ${motion}`
      + (view.observation === "fresh" ? "" : ` · OBSERVATION ${view.observation.toUpperCase()}`)
  ];
}

function signalLine(view, columns, border, useUnicode) {
  const lane = view.selectedLane;
  const signal = lane
    ? `${border.arrow} SIGNAL ${String(view.selectedIndex + 1).padStart(2, "0")}/${String(
      view.lanes.length
    ).padStart(2, "0")}  ${lane.id} · ${STATUS_PRESENTATION[lane.status].label} · ${lane.phase} `
    : `${border.arrow} SIGNAL  NO LANES `;
  const remaining = Math.max(0, columns - displayWidth(signal));
  return truncate(`${signal}${border.signal.repeat(remaining)}`, columns, useUnicode ? "…" : ".");
}

function sectionHeader(labels, widths, border) {
  return labels.map((label, index) => pad(label, widths[index]))
    .join(` ${border.vertical} `)
    .trimEnd();
}

function divider(widths, border) {
  return widths.map((width) => border.horizontal.repeat(width))
    .join(`${border.horizontal}${border.horizontal}${border.horizontal}`);
}

function panelLabel(label, panel, selectedPanel) {
  return panel === selectedPanel ? `[${label}]` : label;
}

function panelBody(view, panel, width, useUnicode) {
  switch (panel) {
    case "detail": return detailLines(view.selectedLane, width);
    case "evidence": return evidenceLines(view.selectedLane, width);
    case "authority": return authorityLines(view.selectedLane, width);
    case "controls": return controlsLines(width);
    default: return laneLines(view, width, useUnicode);
  }
}

function renderWide(view, terminal, border, useUnicode, preferences) {
  const separators = 6;
  const available = terminal.columns - separators;
  const laneWidth = Math.max(34, Math.floor(available * 0.31));
  const authorityWidth = Math.max(30, Math.floor(available * 0.23));
  const detailWidth = available - laneWidth - authorityWidth;
  const widths = [laneWidth, detailWidth, authorityWidth];
  const bodyHeight = Math.max(4, terminal.rows - 7);
  const middlePanel = view.panel === "evidence" ? "evidence" : "detail";
  const middleLabel = middlePanel === "detail"
    ? `${panelLabel("DETAIL", "detail", view.panel)} / ${view.selectedLane?.id ?? "NONE"}`
    : panelLabel(middlePanel.toUpperCase(), middlePanel, view.panel);
  return [
    ...wideMasthead(view, terminal.columns, preferences),
    signalLine(view, terminal.columns, border, useUnicode),
    sectionHeader([
      lanePanelLabel(view),
      middleLabel,
      panelLabel("AUTHORITY", "authority", view.panel)
    ], widths, border),
    divider(widths, border),
    ...joinPanels([
      laneLines(view, laneWidth, useUnicode),
      panelBody(view, middlePanel, detailWidth, useUnicode),
      authorityLines(view.selectedLane, authorityWidth)
    ], widths, bodyHeight, border),
    border.horizontal.repeat(terminal.columns),
    truncate(
      "↑↓: Select lane   Enter: Open agent   Tab: Detail → Evidence → Authority   /: Search lanes   X: Cancel   H/?: Help   Ctrl+G: Return",
      terminal.columns
    )
  ];
}

function renderCompact(view, terminal, border, useUnicode, preferences) {
  const separatorWidth = 3;
  const laneWidth = Math.max(32, Math.floor((terminal.columns - separatorWidth) * 0.39));
  const detailWidth = terminal.columns - separatorWidth - laneWidth;
  const widths = [laneWidth, detailWidth];
  const bodyHeight = Math.max(4, terminal.rows - 7);
  const rightPanel = view.panel;
  const rightTitle = rightPanel.toUpperCase();
  const rightLines = panelBody(view, rightPanel, detailWidth, useUnicode);
  const mark = renderCompactMark(view, preferences);
  const runtime = `RUNTIME ${view.runtime.health.toUpperCase()}`;
  return [
    placeRight(
      `FLEET//OPS  ${versionLabel(preferences)}${view.workspace.name}@${view.workspace.branch}`,
      mark,
      terminal.columns
    ),
    `${summary(view)}  ${runtime}  VIEW ${view.panel.toUpperCase()}  KITE ${motionLabel(preferences)}`
      + (view.observation === "fresh" ? "" : `  OBSERVATION ${view.observation.toUpperCase()}`),
    signalLine(view, terminal.columns, border, useUnicode),
    sectionHeader([
      lanePanelLabel(view),
      panelLabel(rightTitle, rightPanel, view.panel)
    ], widths, border),
    divider(widths, border),
    ...joinPanels([
      laneLines(view, laneWidth, useUnicode),
      rightLines
    ], widths, bodyHeight, border),
    border.horizontal.repeat(terminal.columns),
    truncate(
      "Enter: Open agent  X: Cancel  Tab: View  /: Search lanes  H/?: Help  Ctrl+G: Return",
      terminal.columns
    )
  ];
}

function panelLines(view, width, useUnicode) {
  switch (view.panel) {
    case "detail": return detailLines(view.selectedLane, width);
    case "evidence": return evidenceLines(view.selectedLane, width);
    case "authority": return authorityLines(view.selectedLane, width);
    case "controls": return controlsLines(width);
    default: return laneLines(view, width, useUnicode);
  }
}

function renderNarrow(view, terminal, border, useUnicode, preferences) {
  const title = `VIEW ${view.panel.toUpperCase()} · ${view.selectedLane?.id ?? "NO LANE"}`
    + (view.observation === "fresh" ? "" : ` · OBSERVATION ${view.observation.toUpperCase()}`);
  const bodyHeight = Math.max(3, terminal.rows - 7);
  const mark = renderCompactMark(view, preferences);
  return [
    placeRight(`FLEET//OPS  ${versionLabel(preferences)}${view.workspace.name}`, mark, terminal.columns),
    signalLine(view, terminal.columns, border, useUnicode),
    title,
    border.horizontal.repeat(terminal.columns),
    ...fitPanel(panelLines(view, terminal.columns, useUnicode), bodyHeight, terminal.columns)
      .map((line) => line.trimEnd()),
    border.horizontal.repeat(terminal.columns),
    truncate("Enter: Open agent  X: Cancel  Tab: View  /: Search  Ctrl+G: Return", terminal.columns)
  ];
}

function colorizeLine(line, index, view, theme) {
  if (!theme.enabled) return line;
  let styled = line;
  for (const [status, presentation] of Object.entries(STATUS_PRESENTATION)) {
    const label = presentation.label;
    styled = styled.replaceAll(label, theme.paint(presentation.tone, label));
    if (view.selectedLane?.status === status && styled.includes("SIGNAL")) {
      styled = theme.paint("accent", stripAnsi(styled));
    }
  }
  styled = styled.replace(/[◆◇╲╱▼●•▿╾╼✓⌒⌣▰]/gu, (glyph) => theme.paint("accent", glyph));
  if (index === 0) styled = `${theme.bold}${theme.paint("ink", stripAnsi(styled))}`;
  else if (styled.includes("SIGNAL")) styled = theme.paint("accent", stripAnsi(styled));
  else if (/^[─━=\-]+$/.test(stripAnsi(styled))) styled = theme.paint("dim", stripAnsi(styled));
  return `${theme.ground}${theme.eraseLine}${styled}${theme.reset}`;
}

function normalizedTerminal(terminal = {}) {
  const columns = Number.isInteger(terminal.columns) ? Math.max(1, terminal.columns) : 80;
  const rows = Number.isInteger(terminal.rows) ? Math.max(1, terminal.rows) : 24;
  return { columns, rows };
}

function transcriptMessageLines(message, width) {
  const label = message?.kind === "user"
    ? "[YOU]"
    : message?.kind === "assistant" ? "[CODEX]" : "[ACTIVITY]";
  const prefix = `${label} `;
  const continuation = " ".repeat(displayWidth(prefix));
  const sourceLines = String(message?.text ?? "").split(/\r?\n/u);
  const output = [];
  for (const sourceLine of sourceLines) {
    const wrapped = wrap(sourceLine, Math.max(1, width - displayWidth(prefix)));
    wrapped.forEach((line, index) => output.push(`${index === 0 ? prefix : continuation}${line}`));
  }
  return output.length > 0 ? output : [`${prefix}(empty message)`];
}

function renderCodexSession(view, terminal, border, preferences) {
  const session = preferences.session;
  const lane = view.lanes.find((candidate) => candidate.id === session.laneId)
    ?? view.selectedLane;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const active = ["queued", "running"].includes(lane?.status);
  const mode = active ? "LIVE STEER" : "FOLLOW-UP";
  const activityCount = messages.filter((message) => message?.kind === "activity").length;
  const visibleMessages = session.activityExpanded === true
    ? messages
    : messages.filter((message) => message?.kind !== "activity");
  const transcript = visibleMessages.flatMap((message) => [
    ...transcriptMessageLines(message, terminal.columns),
    ""
  ]);
  if (activityCount > 0 && session.activityExpanded !== true) {
    transcript.push(
      `ACTIVITY ${activityCount} event${activityCount === 1 ? "" : "s"} hidden · /activity to expand`,
      ""
    );
  }
  if (session.loading) transcript.push("Loading the real Codex app-server thread…");
  if (session.error) transcript.push(`SESSION ERROR · ${session.error}`);
  if (preferences.notice) transcript.push(`FLEET · ${preferences.notice}`, "");

  const composerValue = preferences.composer?.value ?? "";
  if (composerValue.trimStart().startsWith("/")) {
    transcript.push(
      "FLEET LOCAL COMMANDS",
      "/latest    Jump to the newest transcript entry",
      "/activity  Expand or collapse safe activity events",
      "/status    Show the selected lane state",
      "/back      Return to the Fleet dashboard",
      ""
    );
  }
  if (transcript.length === 0) transcript.push("No thread messages are available yet.");

  const bodyHeight = Math.max(1, terminal.rows - 9);
  const requestedScroll = Math.max(0, Number.isInteger(session.scroll) ? session.scroll : 0);
  const maximumScroll = Math.max(0, transcript.length - 1);
  const scroll = Math.min(requestedScroll, maximumScroll);
  const end = Math.max(1, transcript.length - scroll);
  const start = Math.max(0, end - bodyHeight);
  const body = fitPanel(transcript.slice(start, end), bodyHeight, terminal.columns);
  const position = scroll === 0
    ? "LATEST"
    : scroll === maximumScroll ? "OLDEST" : `${scroll} LINES BACK`;
  const activityState = session.activityExpanded === true ? "EXPANDED" : "COLLAPSED";
  const composer = `COMPOSE [${mode}] › ${composerValue || "Type a message or / for Fleet commands"}`;
  return [
    truncate(`FLEET//CODEX SESSION  ${session.laneId}`, terminal.columns),
    truncate(
      `THREAD ${session.threadId ?? "PENDING"} · SOURCE ${session.source ?? "unknown"} · MODE ${mode}`,
      terminal.columns
    ),
    truncate(
      `ADMISSION ${session.admissionId ?? "LEGACY"}  `
        + `${session.admissionSource ?? "unknown"}  ${session.admittedAt ?? "time-not-recorded"}`,
      terminal.columns
    ),
    truncate(
      `STATUS ${(lane?.status ?? "unknown").toUpperCase()} · REAL THREAD · reasoning/raw command output hidden`,
      terminal.columns
    ),
    truncate(
      `TRANSCRIPT · ${position} · ${messages.length} messages · ACTIVITY ${activityState}`,
      terminal.columns
    ),
    border.horizontal.repeat(terminal.columns),
    ...body,
    border.horizontal.repeat(terminal.columns),
    truncate(composer, terminal.columns),
    truncate("Enter: Send  ↑/↓: Transcript  /: Fleet commands  Ctrl+G: Dashboard", terminal.columns)
  ].slice(0, terminal.rows);
}

export function renderScreen(viewModel, terminalInput, preferences = {}) {
  const terminal = normalizedTerminal(terminalInput);
  const view = viewModel && typeof viewModel === "object"
    ? viewModel
    : buildViewModel({}, null, "detail");
  const useUnicode = preferences.unicode !== false;
  const border = BORDERS[useUnicode ? "unicode" : "ascii"];
  const theme = createTheme(preferences);
  if (preferences.screenReader === true) {
    const linear = [
      `Fleet workspace ${view.workspace.name}, branch ${view.workspace.branch}.`,
      `${view.lanes.length} lanes; ${view.totals.active} active; ${view.totals.verified} verified.`,
      ...view.lanes.map((lane, index) => (
        `Lane ${index + 1} of ${view.lanes.length}: ${lane.id}, ${lane.status}, ${lane.label}.`
      ))
    ];
    return linear
      .map((line) => truncate(line, terminal.columns))
      .slice(0, terminal.rows)
      .join("\n");
  }
  if (terminal.columns < 32 || terminal.rows < 8) {
    return [
      truncate(`FLEET//OPS ${versionLabel(preferences).trim()}`.trimEnd(), terminal.columns),
      truncate("Terminal too small", terminal.columns),
      truncate("Resize to at least 32x8", terminal.columns)
    ].slice(0, terminal.rows).join("\n");
  }
  if (preferences.session) {
    const lines = renderCodexSession(view, terminal, border, preferences);
    if (preferences.screenReader === true) {
      return lines.map((line) => truncate(stripAnsi(line), terminal.columns)).join("\n");
    }
    return lines
      .map((line, index) => colorizeLine(truncate(line, terminal.columns), index, view, theme))
      .join("\n");
  }
  const lines = terminal.columns >= 120
    ? renderWide(view, terminal, border, useUnicode, preferences)
    : terminal.columns >= 80
      ? renderCompact(view, terminal, border, useUnicode, preferences)
      : renderNarrow(view, terminal, border, useUnicode, preferences);
  return lines.slice(0, terminal.rows)
    .map((line, index) => colorizeLine(truncate(line, terminal.columns), index, view, theme))
    .join("\n");
}
