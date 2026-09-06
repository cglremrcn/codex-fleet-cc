// Pure, local-only navigation. A group is never a runtime lane or an authority grant.
export const GROUP_MODES = Object.freeze(["flat", "folder", "checkout", "status", "role", "model", "project", "source", "parent"]);
const FIELDS = Object.freeze({
  id: "id", status: "status", role: "role", model: "model", effort: "effort",
  checkout: "checkoutKey", folder: "groupPath", label: "label", phase: "phase", project: "project", source: "source", parent: "parentThreadId"
});
const ACTIVE = new Set(["queued", "starting", "running"]);
const ATTENTION = new Set(["blocked", "failed", "interrupted", "outcome_unknown"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** A logical task folder, not a filesystem path. Never use this value for locking. */
export function validateGroupPath(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 160 || CONTROL.test(value)
    || /[\\:]/u.test(value)) throw new TypeError("groupPath must be a safe relative task folder (1-160 characters).");
  const parts = value.split("/");
  if (parts.length > 8 || parts.some((p) => !p.trim() || p !== p.trim() || p === "." || p === "..")) {
    throw new TypeError("groupPath must have 1-8 nonempty relative segments, without dot or parent segments.");
  }
  return value;
}

function fold(value) { return String(value ?? "").toLocaleLowerCase("en-US"); }

/** Literal matching only. AND across terms; commas are OR within a named field. */
export function filterLanes(lanes, query = "") {
  const terms = String(query).slice(0, 256).match(/(?:[^\s"]+|"[^"]*")+/gu) ?? [];
  if (!terms.length) return lanes.slice();
  const predicates = terms.map((raw) => {
    const negative = raw.startsWith("-") && raw.length > 1;
    const term = (negative ? raw.slice(1) : raw).replaceAll('"', "");
    const colon = term.indexOf(":");
    const key = colon > 0 ? fold(term.slice(0, colon)) : null;
    const field = Object.hasOwn(FIELDS, key) ? FIELDS[key] : null;
    const values = field ? fold(term.slice(colon + 1)).split(",") : [fold(term)];
    return (lane) => {
      const haystack = field ? [fold(lane[field])] : Object.values(FIELDS).map((f) => fold(lane[f]));
      const match = values.some((needle) => needle.length > 0 && haystack.some((text) => (
        ["status", "role", "effort"].includes(key) ? text === needle : text.includes(needle)
      )));
      return negative ? !match : match;
    };
  });
  return lanes.filter((lane) => predicates.every((predicate) => predicate(lane)));
}

function folderParts(lane) {
  try { return validateGroupPath(lane.groupPath)?.split("/") ?? ["Ungrouped"]; }
  catch { return ["Ungrouped"]; } // Legacy/malformed display metadata cannot break observation.
}

/** Headers use ':' IDs, which cannot collide with valid Fleet lane identifiers. */
export function buildLaneNavigation(lanes, options = {}) {
  const matches = filterLanes(Array.isArray(lanes) ? lanes : [], options.query);
  const mode = GROUP_MODES.includes(options.mode) ? options.mode : "flat";
  if (mode === "flat") return { lanes: matches, rows: matches, groups: [], mode };
  const collapsed = options.collapsed instanceof Set ? options.collapsed : new Set();
  const root = { children: new Map(), leaves: [] };
  const groups = [];
  for (const lane of matches) {
    const parts = mode === "folder" ? folderParts(lane)
      : [String(lane[mode === "checkout" ? "checkoutKey" : mode] ?? "Unreported")];
    let parent = root;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const name = parts[depth];
      if (!parent.children.has(name)) {
        const id = `group:${mode}:${JSON.stringify(parts.slice(0, depth + 1))}`;
        const node = { id, kind: "group", label: name, depth, parentId: parent.id ?? null,
          count: 0, active: 0, attention: 0, collapsed: collapsed.has(id),
          children: new Map(), leaves: [] };
        parent.children.set(name, node);
        groups.push(node);
      }
      parent = parent.children.get(name);
      parent.count += 1;
      if (ACTIVE.has(lane.status)) parent.active += 1;
      if (ATTENTION.has(lane.status) || lane.controllerRequest) parent.attention += 1;
    }
    parent.leaves.push({ ...lane, depth: parts.length, parentId: parent.id });
  }
  const rows = [];
  function walk(node) {
    const children = [...node.children.values()].sort((a, b) => a.label.localeCompare(b.label, "en"));
    for (const child of children) {
      const { children: ignoredChildren, leaves: ignoredLeaves, ...header } = child;
      rows.push(header);
      if (!child.collapsed) walk(child);
    }
    rows.push(...node.leaves);
  }
  walk(root);
  return { lanes: matches, rows, groups: groups.map(({ children, leaves, ...header }) => header), mode };
}
