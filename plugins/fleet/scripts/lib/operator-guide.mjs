/** Pure presentation vocabulary. These labels never grant runtime authority. */
export const VIEW_LABELS = Object.freeze({
  workspace: Object.freeze({ title: "Current workspace", short: "Workspace", description: "Fleet work admitted in this project only." }),
  projects: Object.freeze({ title: "Registered Fleet projects", short: "Projects", description: "Registered projects on this machine; controls stay bound to the original project." }),
  native: Object.freeze({ title: "Codex sessions (read-only)", short: "Codex read-only", description: "Observed sessions from the connected Codex runtime. Finding a session does not grant control." })
});

export const GROUP_LABELS = Object.freeze({
  flat: "No grouping", folder: "Task folder", checkout: "Checkout", status: "Status",
  role: "Agent role", model: "Model", project: "Project", source: "Thread source", parent: "Parent thread"
});

const SHORT_GROUPS = Object.freeze({
  flat: "Flat", folder: "Folder", checkout: "Checkout", status: "Status", role: "Role",
  model: "Model", project: "Project", source: "Source", parent: "Parent"
});

export function viewContextLine(view = {}, columns = 80) {
  const scope = VIEW_LABELS[view.scope] ?? VIEW_LABELS.workspace;
  const group = GROUP_LABELS[view.groupMode] ?? GROUP_LABELS.flat;
  const shortGroup = SHORT_GROUPS[view.groupMode] ?? SHORT_GROUPS.flat;
  const state = view.observation === "stale" ? "STALE" : view.observation === "loading" ? "LOADING" : "";
  const full = `${state ? `OBSERVATION ${state} | ` : ""}VIEW: ${scope.title} [W] | GROUP BY: ${group} [G]`;
  if (full.length <= columns) return full;
  const short = `${state ? `${state} | ` : ""}W:${scope.short} G:${shortGroup}`;
  if (short.length <= columns) return short;
  return `${state ? `${state} ` : ""}W:${view.scope === "native" ? "Codex" : scope.short} G:${shortGroup}`;
}

export function emptyViewLines(view = {}) {
  if (view.observation === "loading") return ["Loading this view", "Navigation remains available. No empty-fleet conclusion yet."];
  if (view.observation === "stale") return ["Observation unavailable", "This is not proof that the fleet is empty. Use : Refresh inventory."];
  if (view.filterQuery) return ["No matching agents", "Other agents may still be running. Use : Clear filters and folds."];
  if (view.truncated || view.warnings) return ["No agents in this partial view", "Some inventory could not be read. Use : Refresh inventory."];
  if (view.scope === "native") return ["No Codex sessions observed", "Only the connected runtime is visible. This view is read-only."];
  if (view.scope === "projects") return ["No registered Fleet agents", "Register a project or press W to return to the current workspace."];
  return ["No lanes yet", "Start a bounded lane from Claude Code, or press W to inspect other views."];
}

export function operatorFooter(view = {}, columns = 80) {
  const lane = view.selectedLane;
  const readOnly = view.scope === "native" || lane?.controlAvailable === false || lane?.status === "observed";
  const action = view.selectedGroup ? "Fold group" : lane ? readOnly ? "Inspect" : "Open agent" : "";
  const cancel = lane && !readOnly && ["queued", "starting", "running"].includes(lane.status) ? "  X: Cancel" : "";
  const enter = action ? `Enter: ${action}` : ": Commands";
  if (columns >= 144) return `${enter}${cancel}  : Commands  /: Search lanes  Tab: Detail → Evidence → Authority  I: Inbox  K: KITE  ?: Help  Ctrl+G: Return`;
  if (columns >= 67) return `${enter}${cancel}  : Commands  /: Filter  Ctrl+G: Return`;
  if (columns >= 44) return `${action ? `Enter: ${action}` : ": Commands"}  ?: Help  Ctrl+G: Back`;
  return `${action ? readOnly ? "Enter Read" : "Enter Open" : "? Help"}  : Menu  Ctrl+G Back`;
}

export function operatorHelpLines(view = {}) {
  const scope = VIEW_LABELS[view.scope] ?? VIEW_LABELS.workspace;
  return [
    "FLEET CONTROLS / OPERATOR GUIDE",
    "",
    `VIEW: ${scope.title}`,
    scope.description,
    "",
    "W = WHERE to look. Cycle current workspace, registered Fleet projects, and read-only Codex sessions.",
    "G = HOW to arrange that view. Grouping never starts an agent, changes a worktree, or grants permission.",
    "Use : Commands to choose a view or a Group by option by its full name; no shortcut memorization is required.",
    "",
    "NAVIGATION",
    "Up/Down or j/k select. Enter opens a real agent; Enter/Space folds a group. A heading is not an agent.",
    "Tab selects Detail, Evidence or Authority. / filters this view; : Clear filters reveals hidden matches.",
    "I opens the intervention inbox. Questions and permission approvals are different decisions.",
    "",
    "TRUST AND RECOVERY",
    "LIVE means starting/running. QUEUED means waiting, not executing. COMPLETE is a worker claim, not VERIFIED evidence.",
    "STALE is last-known information, not a live observation. Loading and filtered-empty views do not prove the whole fleet is idle.",
    "Native Codex sessions are read-only. Fleet controls stay bound to their original project, lane and turn identity.",
    "X requests cancellation of owned active work; confirmation and live authority checks still apply. Cancellation does not undo effects.",
    "R requests recovery. OUTCOME UNKNOWN must be reconciled with evidence, never blindly retried.",
    "",
    "KITE",
    "K opens the companion. P pauses motion. Its pose summarizes reported state; animation is not a progress percentage or verification.",
    "",
    "Ctrl+G returns to Claude Code from the dashboard. Esc closes this guide without changing any agent."
  ];
}
