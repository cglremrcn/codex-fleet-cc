/** KITE v2: deterministic state projection. No timers, model calls, random progress or I/O. */
const ANIMATED = new Set(["running", "starting", "queued", "complete"]);
const ATTENTION = new Set(["blocked", "failed", "interrupted", "outcome_unknown"]);
const COPY = Object.freeze({
  idle: ["IDLE", "No retained agents in this view. Nothing is secretly running.", "muted"],
  observed: ["OBSERVING", "This Codex session is read-only here. Its owning client retains control.", "muted"],
  queued: ["QUEUED", "Waiting for scheduler capacity. A visible agent is not necessarily executing.", "muted"],
  starting: ["STARTING", "The task is admitted; runtime identity is being established.", "running"],
  running: ["RUNNING", "Work is in progress. Motion is an activity signal, not a percentage or a quality score.", "running"],
  complete: ["AWAITING VERIFICATION", "The worker reported completion. The result is not independently verified.", "ink"],
  verified: ["VERIFIED", "The reported lane state is verified. Inspect its evidence before relying on the result.", "verified"],
  question: ["QUESTION WAITING", "A response is needed. Technical answers and permission grants are separate decisions.", "running"],
  approval: ["APPROVAL WAITING", "A human decision is required. A Claude suggestion cannot grant permission.", "running"],
  attention: ["REVIEW REQUEST", "A request needs review; its type is not established. No automatic answer is assumed.", "running"],
  blocked: ["BLOCKED", "Work needs missing input or capability. Inspect the blocker; do not blindly retry.", "running"],
  failed: ["FAILED", "The agent stopped without a usable result. Review its evidence and failure reason.", "danger"],
  cancelled: ["CANCELLED", "The owned turn was cancelled. Cancellation does not undo earlier side effects.", "muted"],
  interrupted: ["INTERRUPTED", "Runtime supervision ended. Reconcile the existing work before restarting it.", "running"],
  outcome_unknown: ["OUTCOME UNKNOWN", "An operation's outcome is unresolved. Reconcile first; never repeat it blindly.", "danger"],
  stale: ["OBSERVATION STALE", "The latest observation could not be confirmed. This is the last known state, not live proof.", "danger"]
});
const count = (value) => Number.isSafeInteger(value) && value > 0 ? Math.min(4096, value) : 0;

export function deriveKiteSignal(view = {}) {
  const lanes = Array.isArray(view.lanes) ? view.lanes : [];
  const selected = view.selectedLane ?? null;
  const totals = {
    agents: lanes.length,
    active: lanes.filter((lane) => ["running", "starting"].includes(lane.status)).length,
    queued: lanes.filter((lane) => lane.status === "queued").length,
    attention: lanes.filter((lane) => ATTENTION.has(lane.status) || lane.controllerRequest || count(lane.pendingRequests)).length,
    requests: lanes.reduce((n, lane) => n + count(lane.pendingRequests), 0)
  };
  let state = selected?.status ?? (totals.active ? "running" : totals.attention ? "attention" : totals.queued ? "queued" : lanes.length ? "observed" : "idle");
  if (selected?.pendingApprovalCount > 0) state = "approval";
  else if (selected?.pendingQuestionCount > 0) state = "question";
  else if (selected?.pendingRequests > 0) state = "attention";
  if (selected?.status === "outcome_unknown") state = "outcome_unknown";
  if (view.observation === "stale" || view.observation === "loading") state = "stale";
  if (!COPY[state]) state = "attention";
  const [label, description, tone] = COPY[state];
  return Object.freeze({ state, label, description, tone, animated: ANIMATED.has(state),
    targetId: selected?.id ?? null, source: selected ? "selected agent" : "visible fleet", totals: Object.freeze(totals) });
}

export function kiteIsAnimated(signal, preferences = {}) {
  return signal?.animated === true && preferences.mascot !== false && preferences.motion !== false
    && preferences.reducedMotion !== true && preferences.screenReader !== true;
}

function features(signal, preferences) {
  const state = signal?.state ?? "idle";
  const unicode = preferences.unicode !== false;
  const frame = kiteIsAnimated(signal, preferences) && Number.isSafeInteger(preferences.frame)
    ? Math.abs(preferences.frame) % 8 : 0;
  const u = {
    idle: ["·", "·", "─", "○"], observed: ["◎", "◎", "─", "◉"],
    queued: ["·", "·", "⌄", "○"], starting: ["•", "•", "⌄", "◌"],
    running: [frame === 6 ? "─" : "●", frame === 6 ? "─" : "●", "▿", "◆"],
    complete: ["•", "•", frame % 2 ? "⌁" : "─", frame % 2 ? "◈" : "◇"],
    verified: ["⌒", "⌒", "⌣", "✓"], question: ["●", "●", "?", "?"],
    approval: ["─", "─", "!", "!"], attention: ["•", "•", "?", "!"],
    blocked: ["─", "─", "!", "!"], failed: ["×", "×", "─", "×"],
    cancelled: ["·", "·", "─", "–"], interrupted: ["─", "─", "│", "‖"],
    outcome_unknown: ["?", "?", "·", "?"], stale: ["·", "·", "?", "~"]
  };
  const a = { idle: [".", ".", "-", "o"], observed: ["o", "o", "-", "O"],
    queued: [".", ".", "v", "Q"], starting: ["o", "o", "v", "S"],
    running: [frame === 6 ? "-" : "o", frame === 6 ? "-" : "o", "v", "R"],
    complete: [".", ".", frame % 2 ? "~" : "-", frame % 2 ? "+" : "C"],
    verified: ["^", "^", "u", "V"], question: ["o", "o", "?", "?"],
    approval: ["-", "-", "!", "!"], attention: [".", ".", "?", "!"],
    blocked: ["-", "-", "!", "!"], failed: ["x", "x", "-", "X"],
    cancelled: [".", ".", "-", "-"], interrupted: ["-", "-", "|", "I"],
    outcome_unknown: ["?", "?", ".", "?"], stale: [".", ".", "?", "~"] };
  return { frame, face: (unicode ? u : a)[state] ?? (unicode ? u.attention : a.attention), unicode };
}

export function renderKiteBadge(signal, preferences = {}) {
  if (preferences.mascot === false) return "";
  const { face: [left, right, , core], unicode } = features(signal, preferences);
  return unicode ? `╭▰ ${left} ${right} ▰╮${core}` : `[= ${left} ${right} =]${core}`;
}

/** Fixed seven-row, 27-column terminal avatar. ASCII fallback contains no Unicode. */
export function renderKiteAvatar(signal, preferences = {}) {
  if (preferences.mascot === false || preferences.screenReader === true) return [];
  const { face: [left, right, mouth, core], frame, unicode } = features(signal, preferences);
  const wing = [0, 1, 2, 3, 2, 1, 0, 1][frame];
  const orbit = unicode ? "◇" : "*";
  const gap = 17 - wing * 2;
  const lines = unicode ? [
    `${" ".repeat(wing)}${orbit}${" ".repeat(gap)}${orbit}`,
    "╲       ╭───╮       ╱",
    `╭━━━╾▰  ${left} ${right}  ▰╼━━━╮`,
    `╰━╮     ${mouth}     ╭━╯`,
    `  ╲   ╭─${core}─╮   ╱`,
    "   ╰━━╯   ╰━━╯",
    "      ╲ │ ╱"
  ] : [
    `${" ".repeat(wing)}${orbit}${" ".repeat(gap)}${orbit}`,
    "\\       .---.       /",
    `[====  ${left} ${right}  ====]`,
    `\\        ${mouth}        /`,
    `  \\   [-${core}-]   /`,
    "   '=='   '=='",
    "      \\ | /"
  ];
  return lines.map((line) => line.padStart(Math.floor((27 - line.length) / 2) + line.length).padEnd(27));
}
