import crypto from "node:crypto";
import { GROUP_MODES } from "./lane-navigation.mjs";
import { readPrivateRecord, writePrivateRecord, withPrivateRecordLock } from "./private-record.mjs";
import { resolveOwnedPath } from "./paths.mjs";

const CLEAN = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/u;
const SCOPES = new Set(["workspace", "projects", "native"]);
const SORTS = new Set(["original", "attention", "recent", "name"]);

export const DEFAULT_CONSOLE_VIEW = Object.freeze({
  scope: "workspace", groupMode: "flat", filterQuery: "", sort: "original",
  collapsedGroups: [], favorites: [], selectedLaneId: null, mascot: true, motion: true
});

function boundedText(value, maximum, fallback = "") {
  if (typeof value !== "string" || value.length > maximum || !CLEAN.test(value)) return fallback;
  return value;
}

export function normalizeConsoleView(input = {}) {
  const strings = (value, maximum, length) => Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string" && item.length <= length && CLEAN.test(item)))].slice(0, maximum) : [];
  return {
    scope: SCOPES.has(input.scope) ? input.scope : "workspace",
    groupMode: GROUP_MODES.includes(input.groupMode) ? input.groupMode : "flat",
    filterQuery: boundedText(input.filterQuery, 256),
    sort: SORTS.has(input.sort) ? input.sort : "original",
    collapsedGroups: strings(input.collapsedGroups, 512, 1024),
    favorites: strings(input.favorites, 128, 320),
    selectedLaneId: boundedText(input.selectedLaneId, 320, null),
    mascot: input.mascot !== false, motion: input.motion !== false
  };
}

function stateFile(dataDir, key) {
  if (!/^[a-f0-9]{32}$/u.test(key)) throw new TypeError("Invalid console workspace key.");
  return resolveOwnedPath(dataDir, "workspaces", key, "console-view.json");
}

function normalizeState(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.savedViews) || value.savedViews.length > 16) {
    throw new Error("Console preferences are invalid; the previous file has not been overwritten.");
  }
  const seen = new Set();
  const savedViews = value.savedViews.map((saved) => {
    const name = boundedText(saved?.name, 48);
    if (!name.trim() || seen.has(name)) throw new Error("Invalid saved view name.");
    seen.add(name);
    return { name, view: normalizeConsoleView(saved.view) };
  });
  return { schemaVersion: 1, current: normalizeConsoleView(value.current), savedViews };
}

/** Versioned last-view persistence with optimistic conflict detection between consoles. */
export async function readConsolePreferences(dataDir, key) {
  const value = await readPrivateRecord(stateFile(dataDir, key), { missing: null });
  const normalized = value ? normalizeState(value) : { schemaVersion: 1, current: normalizeConsoleView(), savedViews: [] };
  return { ...normalized, revision: digest(value) };
}

function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function writeConsolePreferences(dataDir, key, value, expectedRevision) {
  const file = stateFile(dataDir, key);
  return withPrivateRecordLock(file, async () => {
    const previous = await readPrivateRecord(file, { missing: null });
    if (expectedRevision !== undefined && digest(previous) !== expectedRevision) throw new Error("Console preferences changed in another console; reload before saving.");
    const state = normalizeState(value);
    await writePrivateRecord(file, state);
    return { ...state, revision: digest(state) };
  });
}

export function sortConsoleLanes(lanes, sort = "original", favorites = []) {
  const favoritesSet = new Set(favorites);
  const attention = new Set(["blocked", "failed", "interrupted", "outcome_unknown"]);
  const score = (lane) => lane.controllerRequest || lane.pendingRequests > 0 || attention.has(lane.status) ? 0
    : ["running", "starting"].includes(lane.status) ? 1 : lane.status === "queued" ? 2 : 3;
  const recent = (lane) => typeof lane.updatedAt === "number" ? lane.updatedAt * 1000 : Date.parse(lane.updatedAt ?? "") || 0;
  return lanes.map((lane, index) => ({ lane, index })).sort((a, b) => {
    const favored = Number(favoritesSet.has(b.lane.id)) - Number(favoritesSet.has(a.lane.id));
    if (favored) return favored;
    if (sort === "attention") return score(a.lane) - score(b.lane) || a.index - b.index;
    if (sort === "recent") return recent(b.lane) - recent(a.lane) || a.index - b.index;
    if (sort === "name") return String(a.lane.label ?? a.lane.id).localeCompare(String(b.lane.label ?? b.lane.id), "en") || a.index - b.index;
    return a.index - b.index;
  }).map(({ lane }) => lane);
}
