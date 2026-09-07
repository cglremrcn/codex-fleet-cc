import crypto from "node:crypto";
import { resolveOwnedPath } from "./paths.mjs";
import { listRegisteredWorkspaces } from "./workspace-registry.mjs";
import { readPrivateRecord } from "./private-record.mjs";
import { filterLanes } from "./lane-navigation.mjs";
import { redactText, sanitizeLaneForPersistence } from "./redaction.mjs";

export const NATIVE_SOURCE_KINDS = Object.freeze([
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact",
  "subAgentThreadSpawn", "subAgentOther", "unknown"
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_INVENTORY = 8192;

export function displayText(value, maximum = 120) {
  return redactText(typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, maximum);
}

/** Metadata only. It never starts supervisors, resumes threads, or reads transcripts. */
export async function readFleetInventory(dataDir) {
  const catalogue = await listRegisteredWorkspaces(dataDir);
  const lanes = [], warnings = [...catalogue.warnings];
  let truncated = catalogue.truncated;
  // Sequential, bounded reads avoid an unbounded file-descriptor storm on large histories.
  for (const project of catalogue.projects) {
    try {
      const state = await readPrivateRecord(resolveOwnedPath(dataDir, "workspaces", project.workspaceKey, "state.json"), {
        missing: null, maxBytes: 2 * 1024 * 1024
      });
      if (!state) continue;
      if (state.schemaVersion !== 1 || !Array.isArray(state.lanes) || state.lanes.length > 256) throw new Error("Malformed state.");
      for (const lane of state.lanes) {
        if (!SAFE_ID.test(lane?.id ?? "") || lane.workspaceKey !== project.workspaceKey) {
          warnings.push({ workspaceKey: project.workspaceKey, reason: "invalid-lane-identity" });
          continue;
        }
        if (lanes.length >= MAX_INVENTORY) { truncated = true; break; }
        lanes.push({
          ...sanitizeLaneForPersistence(lane),
          id: `${project.workspaceKey}:${lane.id}`,
          controlId: lane.id,
          project: displayText(project.name),
          source: "fleet",
          controlAvailable: project.registered,
          observation: "stored",
          originWorkspaceKey: project.workspaceKey
        });
      }
    } catch {
      warnings.push({ workspaceKey: project.workspaceKey, reason: "workspace-state-unreadable" });
    }
    if (lanes.length >= MAX_INVENTORY) break;
  }
  return { schemaVersion: 1, source: "fleet-local-index", projects: catalogue.projects, lanes, warnings, truncated };
}

function runtimeId(value) {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) {
    throw new Error("Invalid Codex thread identifier.");
  }
  return value;
}

export function normalizeNativeThread(thread, managed = new Map()) {
  const threadId = runtimeId(thread?.id);
  const own = managed.get(threadId);
  const source = typeof thread.source === "string" ? thread.source : Object.keys(thread.source ?? {})[0] ?? "unknown";
  const parent = thread.parentThreadId ?? null;
  const status = typeof thread.status === "string" ? thread.status : thread.status?.type ?? "unknown";
  return Object.freeze({
    id: `codex:${threadId}`, threadId, controlId: own?.id ?? null,
    label: displayText(thread.name || thread.agentNickname || `Codex ${threadId.slice(0, 12)}`),
    role: "observed-codex", project: displayText(thread.cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Unknown workspace"),
    // A discovery response is not a grant, including for child threads of a managed lane.
    controlAvailable: false, source: displayText(source, 48), observation: "runtime-metadata",
    nativeStatus: displayText(status, 48), status: status === "active" ? "running" : "observed",
    phase: `observed/${displayText(status, 48)}`, model: displayText(thread.model ?? "not-reported", 80),
    effort: displayText(thread.reasoningEffort ?? "not-reported", 32), authority: {},
    parentThreadId: parent === null ? null : runtimeId(parent), managedLaneId: own?.id ?? null,
    updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
    activeFlags: Array.isArray(thread.status?.activeFlags)
      ? thread.status.activeFlags.slice(0, 8).map((flag) => displayText(flag, 64)) : []
  });
}

/** Explicit sourceKinds are essential: [] defaults to interactive sources, not all sources. */
export async function discoverNativeThreads(request, options = {}) {
  const maxPages = options.maxPages ?? 20;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new TypeError("Invalid native inventory page budget.");
  const records = new Map(), seenCursors = new Set(), warnings = [];
  let cursor = null, truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await request("thread/list", {
      cursor, limit: 100, sortKey: "updated_at", modelProviders: [], sourceKinds: [...NATIVE_SOURCE_KINDS],
      archived: options.archived === true, useStateDbOnly: true,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });
    if (!Array.isArray(result?.data) || result.data.length > 1000) throw new Error("Malformed Codex thread inventory.");
    for (const thread of result.data) {
      const normalized = normalizeNativeThread(thread, options.managed);
      records.set(normalized.threadId, normalized);
    }
    cursor = result.nextCursor ?? null;
    if (cursor === null) break;
    if (typeof cursor !== "string" || !cursor.length || cursor.length > 4096 || seenCursors.has(cursor)) throw new Error("Invalid or repeating Codex inventory cursor.");
    seenCursors.add(cursor);
    if (page + 1 === maxPages) truncated = true;
  }
  if (options.includeLoaded === true && options.archived !== true) {
    // Ephemeral threads may be absent from the state DB. Enumerate only this broker's
    // loaded threads and inspect metadata, never hydrate transcripts or resume them.
    let loadedCursor = null, reads = 0;
    const loadedCursors = new Set();
    try {
      for (let page = 0; page < 4; page += 1) {
        const loaded = await request("thread/loaded/list", { cursor: loadedCursor, limit: 100 });
        if (!Array.isArray(loaded?.data) || loaded.data.length > 100) throw new Error("Malformed loaded inventory.");
        for (const id of loaded.data) {
          runtimeId(id);
          if (records.has(id)) continue;
          if (reads >= 256) { truncated = true; break; }
          reads += 1;
          try {
            const result = await request("thread/read", { threadId: id, includeTurns: false });
            const item = normalizeNativeThread(result?.thread, options.managed);
            if (item.threadId !== id) throw new Error("Thread identity mismatch.");
            records.set(id, item);
          } catch { warnings.push({ reason: "loaded-thread-unavailable", threadId: id }); }
        }
        loadedCursor = loaded.nextCursor ?? null;
        if (!loadedCursor) break;
        if (typeof loadedCursor !== "string" || loadedCursor.length > 4096 || loadedCursors.has(loadedCursor)) throw new Error("Invalid loaded cursor.");
        loadedCursors.add(loadedCursor);
        if (page === 3 || reads >= 256) { truncated = true; break; }
      }
    } catch { warnings.push({ reason: "loaded-inventory-unavailable" }); }
  }
  return { schemaVersion: 1, source: "codex-thread-list", lanes: [...records.values()], truncated, warnings,
    // Upstream truncation and local supervisor pagination have separate cursor namespaces.
    upstreamNextCursor: cursor, nextCursor: null };
}

export function paginateInventory(inventory, options = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("Inventory limit must be 1-500.");
  const query = options.query ?? "";
  if (typeof query !== "string" || query.length > 256) throw new TypeError("Invalid inventory query.");
  const lanes = filterLanes(inventory.lanes, query);
  const revision = crypto.createHash("sha256").update(JSON.stringify(lanes.map((lane) => [lane.id, lane.status, lane.updatedAt, lane.phase]))).digest("hex").slice(0, 24);
  let offset = 0;
  if (options.cursor) {
    if (typeof options.cursor !== "string" || options.cursor.length > 256) throw new Error("Invalid inventory cursor.");
    let decoded;
    try { decoded = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid inventory cursor."); }
    if (decoded.revision !== revision) throw new Error("Inventory changed; restart pagination without a cursor.");
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > lanes.length) throw new Error("Invalid inventory offset.");
    offset = decoded.offset;
  }
  let next = Math.min(offset + limit, lanes.length);
  let page = lanes.slice(offset, next);
  // A supervisor frame is bounded to 256 KiB; keep headroom for the envelope.
  while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > 192 * 1024) {
    next = offset + Math.ceil(page.length / 2); page = lanes.slice(offset, next);
  }
  if (Buffer.byteLength(JSON.stringify(page)) > 192 * 1024) throw new Error("Inventory item exceeds the page budget.");
  return { ...inventory, lanes: page, total: lanes.length,
    nextCursor: next < lanes.length ? Buffer.from(JSON.stringify({ revision, offset: next })).toString("base64url") : null };
}
