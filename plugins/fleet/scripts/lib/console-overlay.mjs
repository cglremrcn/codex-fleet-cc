import { deriveKiteSignal, renderKiteAvatar } from "./kite-companion.mjs";
import { displayWidth, stripAnsi } from "./tui-render.mjs";

export const OPERATOR_COMMANDS = Object.freeze([
  { id: "kite", title: "KITE companion", description: "Real activity, waiting requests and local operator controls" },
  { id: "scope:workspace", title: "Current workspace", description: "Return to this Claude project's Fleet lanes" },
  { id: "scope:projects", title: "All Fleet projects", description: "Registered and retained projects, grouped without model calls" },
  { id: "scope:native", title: "All Codex sessions", description: "Discover CLI, app-server and native child threads; observation only" },
  { id: "refresh", title: "Refresh inventory", description: "Read the current scope again; never starts an inference turn" },
  { id: "attention", title: "Attention first", description: "Prioritize blocked, unknown and controller-requested work" },
  { id: "sort:recent", title: "Sort by most recent", description: "Keep the latest reported activity at the top" },
  { id: "sort:name", title: "Sort by name", description: "Alphabetical task labels" },
  { id: "sort:original", title: "Original ordering", description: "Restore the source's ordering" },
  { id: "favorite", title: "Pin / unpin selected agent", description: "Keep important agents above the current ordering" },
  { id: "saveView", title: "Save this view", description: "Name this scope, filter, ordering and fold state" },
  { id: "toggleMascot", title: "Show / hide KITE", description: "Toggle the local mascot without hiding task status" },
  { id: "toggleMotion", title: "Pause / resume motion", description: "Reduced-motion preference always takes precedence" },
  { id: "clear", title: "Clear filters and folds", description: "Reveal all agents in this scope" }
]);

function clipped(value, columns) {
  const text = stripAnsi(String(value ?? "")).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
  let result = "";
  for (const character of text) {
    if (displayWidth(result + character) > columns) break;
    result += character;
  }
  return result;
}

export function paletteItems(query, savedViews = [], extraCommands = []) {
  const terms = String(query ?? "").trim().toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  return [...OPERATOR_COMMANDS, ...extraCommands, ...savedViews.map((saved) => ({
    id: `view:${saved.name}`, title: `Load view: ${saved.name}`, description: `${saved.view.scope} · ${saved.view.groupMode} · ${saved.view.filterQuery || "no filter"}`
  }))].filter((item) => terms.every((term) => `${item.title} ${item.description}`.toLocaleLowerCase("en-US").includes(term)));
}

/** A local, bounded overlay; its rows cannot become runtime action targets. */
export function renderOperatorOverlay(overlay, terminal, options = {}) {
  const columns = Math.max(1, terminal.columns ?? 80), rows = Math.max(1, terminal.rows ?? 24);
  if (overlay.kind === "kite") return renderCompanion(overlay, terminal, options);
  const lines = [overlay.kind === "saveView" ? "SAVE VIEW · local preferences" : "FLEET COMMAND CENTER · local commands", ""];
  lines.push(`> ${overlay.query ?? ""}_`, "");
  if (overlay.kind === "saveView") {
    lines.push("Type a unique view name (up to 48 characters).", "Enter saves · Esc returns without saving.");
  } else {
    const items = paletteItems(overlay.query, options.savedViews, options.extraCommands);
    const index = Math.max(0, Math.min(overlay.index ?? 0, items.length - 1));
    const capacity = Math.max(1, Math.floor((rows - 6) / 2));
    const offset = Math.max(0, Math.min(index - capacity + 1, items.length - capacity));
    if (!items.length) lines.push("No matching commands. Clear the search to see all commands.");
    for (const [relative, item] of items.slice(offset, offset + capacity).entries()) {
      lines.push(`${offset + relative === index ? ">" : " "} ${item.title}`, `    ${item.description}`);
    }
  }
  while (lines.length < rows - 1) lines.push("");
  lines[rows - 1] = "↑↓ Select · Enter Run · Esc Close · No model turn for navigation";
  return lines.slice(0, rows).map((line) => clipped(line, columns)).join("\n");
}

export function companionItems(options = {}) {
  const wanted = ["attention", "refresh", "toggleMotion", "toggleMascot"];
  const inbox = (options.extraCommands ?? []).find((item) => item.id === "inbox");
  return [...(inbox ? [inbox] : []), ...wanted.map((id) => OPERATOR_COMMANDS.find((item) => item.id === id))];
}

function renderCompanion(overlay, terminal, options) {
  const columns = Math.max(1, terminal.columns ?? 80), rows = Math.max(1, terminal.rows ?? 24);
  const signal = deriveKiteSignal(options.view);
  const items = companionItems(options);
  const index = Math.max(0, Math.min(overlay.index ?? 0, items.length - 1));
  const lines = [`KITE / OPERATOR COMPANION · ${signal.label}`];
  if (rows >= 24 && columns >= 48) lines.push(...renderKiteAvatar(signal, options.preferences ?? {}));
  lines.push(`${signal.source.toUpperCase()} · ${signal.targetId ?? "no selected agent"}`);
  // Wrap without silently dropping long explanations in a narrow terminal.
  let line = "";
  for (const word of signal.description.split(" ")) {
    if (displayWidth(`${line} ${word}`.trim()) > columns && line) { lines.push(line); line = ""; }
    line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  lines.push(`VISIBLE: ${signal.totals.agents} agents · ${signal.totals.active} active · ${signal.totals.attention} attention · ${signal.totals.requests} requests`, "");
  const available = Math.max(1, rows - lines.length - 1);
  const offset = Math.max(0, index - available + 1);
  // Tiny terminals prioritize the selected action rather than hiding navigation.
  if (lines.length >= rows - 1) lines.splice(Math.max(1, rows - 3));
  for (let i = offset; i < items.length && lines.length < rows - 1; i++) lines.push(`${i === index ? ">" : " "} ${items[i].title}`);
  while (lines.length < rows - 1) lines.push("");
  lines[rows - 1] = "↑↓ Select · Enter Run · Esc Close · Local controls; no model call";
  return lines.slice(0, rows).map((text) => clipped(text, columns)).join("\n");
}
