const ANSI_SEQUENCE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;
const MAX_FIELD = 120;
const MAX_LANES = 32;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const CONTROLLER_STATUSES = new Set(["blocked", "interrupted"]);
const ATTENTION_STATUSES = new Set(["failed", "cancelled", "outcome_unknown"]);

function field(value, fallback = "unknown") {
  const cleaned = String(value ?? fallback)
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (cleaned || fallback).slice(0, MAX_FIELD);
}

function laneTimestamp(lane) {
  for (const candidate of [
    lane?.finishedAt,
    lane?.startedAt,
    lane?.admittedAt,
    lane?.enqueuedAt,
    lane?.createdAt
  ]) {
    const timestamp = Date.parse(candidate ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function attentionRank(lane) {
  if (ACTIVE_STATUSES.has(lane?.status)) return 0;
  if (lane?.controllerRequest || CONTROLLER_STATUSES.has(lane?.status)) return 1;
  if (ATTENTION_STATUSES.has(lane?.status)) return 2;
  return 3;
}

export function selectStatusLanes(lanes, options = {}) {
  const source = Array.isArray(lanes) ? lanes : [];
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? new Set(options.statuses)
    : null;
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null;
  const matching = source.filter((lane) => {
    if (statuses && !statuses.has(lane?.status)) return false;
    return sinceMs === null || laneTimestamp(lane) >= sinceMs;
  }).sort((left, right) => (
    attentionRank(left) - attentionRank(right)
    || laneTimestamp(right) - laneTimestamp(left)
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""), "en")
  ));
  const limit = Number.isInteger(options.limit) ? options.limit : matching.length;
  const selected = matching.slice(0, limit);
  const omittedCounts = new Map();
  for (const lane of matching.slice(selected.length)) {
    const status = String(lane?.status ?? "unknown");
    omittedCounts.set(status, (omittedCounts.get(status) ?? 0) + 1);
  }
  const omittedByStatus = Object.fromEntries(
    [...omittedCounts.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))
  );
  return Object.freeze({
    lanes: selected,
    total: source.length,
    matching: matching.length,
    shown: selected.length,
    omitted: matching.length - selected.length,
    hasOutcomeUnknown: matching.some((lane) => lane?.status === "outcome_unknown"),
    omittedByStatus
  });
}

export function renderPlainStatus(snapshot = {}) {
  const workspace = snapshot.workspace ?? {};
  const runtime = snapshot.runtime ?? {};
  const rawLanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
  const selection = snapshot.selection ?? selectStatusLanes(rawLanes, { limit: MAX_LANES });
  const lanes = rawLanes.slice(0, selection.shown);
  const lines = [
    `Fleet workspace ${field(workspace.name)}, branch ${field(workspace.branch)}`,
    `Runtime ${field(runtime.health)}, protocol ${field(runtime.protocol)}`,
    `Showing ${selection.shown}/${selection.total} lanes.`
  ];

  if (lanes.length === 0) {
    lines.push("No Fleet lanes recorded.");
  } else {
    const total = lanes.length;
    lanes.forEach((lane, index) => {
      lines.push(
        `Lane ${index + 1} of ${total}: ${field(lane?.id)}, ${field(lane?.status)}, `
        + `${field(lane?.role)}, ${field(lane?.label)}`
      );
      if (
        lane?.status === "running"
        && typeof lane?.phase === "string"
        && /^recovering \d+\/\d+$/u.test(lane.phase)
      ) {
        lines.push(`  RECOVERING ${field(lane.phase.slice("recovering ".length))}`);
      }
      if (lane?.controllerRequest && typeof lane.controllerRequest === "object") {
        lines.push(
          `  CLAUDE ACTION [${field(lane.controllerRequest.kind, "runtime_blocker")}]: `
          + field(lane.controllerRequest.question, "Controller attention required")
        );
      }
      if (lane?.pendingContinuation && typeof lane.pendingContinuation === "object") {
        lines.push(
          `  CONTINUATION ${field(lane.pendingContinuation.state, "outcome_unknown")}`
            .toUpperCase()
            .replaceAll("_", " ")
        );
      }
    });
    if (selection.omitted > 0) {
      const counts = Object.entries(selection.omittedByStatus)
        .map(([status, count]) => `${field(status)}=${count}`)
        .join(", ");
      lines.push(`${selection.omitted} additional lanes omitted from plain status.`);
      lines.push(`Omitted by status: ${counts}.`);
    }
  }
  return `${lines.join("\n")}\n`;
}
