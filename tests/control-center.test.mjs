import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workspaceKey, resolveOwnedPath, getFleetDataDir } from "../plugins/fleet/scripts/lib/paths.mjs";
import { registerWorkspace, listRegisteredWorkspaces, resolveRegisteredWorkspace } from "../plugins/fleet/scripts/lib/workspace-registry.mjs";
import { readPrivateRecord, writePrivateRecord, withPrivateRecordLock } from "../plugins/fleet/scripts/lib/private-record.mjs";
import { readFleetInventory, discoverNativeThreads, normalizeNativeThread, paginateInventory, NATIVE_SOURCE_KINDS } from "../plugins/fleet/scripts/lib/fleet-inventory.mjs";
import { readConsolePreferences, writeConsolePreferences, normalizeConsoleView, sortConsoleLanes } from "../plugins/fleet/scripts/lib/console-preferences.mjs";
import { createConsoleController } from "../plugins/fleet/scripts/lib/console-controller.mjs";
import { createInputDecoder } from "../plugins/fleet/scripts/lib/tui-input.mjs";
import { buildViewModel, displayWidth, renderScreen, stripAnsi } from "../plugins/fleet/scripts/lib/tui-render.mjs";
import { renderOperatorOverlay } from "../plugins/fleet/scripts/lib/console-overlay.mjs";
import { createFileStateReader, createSupervisorRuntime } from "../plugins/fleet/scripts/fleet-console.mjs";
import { runCli } from "../plugins/fleet/scripts/lib/cli.mjs";
import { FleetRuntime } from "../plugins/fleet/scripts/lib/runtime-adapter.mjs";

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-control-center-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  const key = await workspaceKey(workspace);
  return { root, dataDir, workspace, key };
}
const lane = (id = "agent", extra = {}) => ({ id, label: "Inspect subsystem", role: "investigator", model: "test-model", effort: "high", status: "running", phase: "running", threadId: `thread-${id}`, turnId: `turn-${id}`, authority: { process: { start: true, stopOwned: true } }, ...extra });
const snapshot = (lanes = [lane()]) => ({ schemaVersion: 1, lanes, workspace: { name: "Project", branch: "main" }, runtime: {} });
const native = (id = "native-a", extra = {}) => ({ id, name: "Native task", source: "cli", parentThreadId: null, model: "test-model", reasoningEffort: "high", cwd: "/project", status: { type: "idle" }, updatedAt: 1, ...extra });

async function persistFixture(dataDir, workspace, id = "agent") {
  const registration = await registerWorkspace(dataDir, workspace);
  await writePrivateRecord(resolveOwnedPath(dataDir, "workspaces", registration.workspaceKey, "state.json"), {
    schemaVersion: 1, lanes: [lane(id, { workspaceKey: registration.workspaceKey, prompt: "PRIVATE PROMPT" })]
  });
  return registration;
}

test("read-only global inventory does not create directories or models", async (t) => {
  const { dataDir } = await setup(t);
  assert.deepEqual(await readFleetInventory(dataDir), { schemaVersion: 1, source: "fleet-local-index", projects: [], lanes: [], warnings: [], truncated: false });
  await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
});

test("registration retains canonical routing privately and inventory namespaces repeated IDs", async (t) => {
  const { root, dataDir, workspace } = await setup(t);
  const second = path.join(root, "other"); await fs.mkdir(second);
  await persistFixture(dataDir, workspace); await persistFixture(dataDir, second);
  const index = await readFleetInventory(dataDir);
  assert.equal(index.lanes.length, 2);
  assert.equal(new Set(index.lanes.map((item) => item.id)).size, 2);
  assert.ok(index.lanes.every((item) => item.controlId === "agent" && item.controlAvailable));
  assert.ok(!JSON.stringify(index).includes(root));
  assert.ok(!JSON.stringify(index).includes("PRIVATE PROMPT"));
  assert.equal((await resolveRegisteredWorkspace(dataDir, index.projects[0].workspaceKey)).workspaceKey, index.projects[0].workspaceKey);
});

test("legacy workspace records remain visible without granting control", async (t) => {
  const { dataDir, key } = await setup(t);
  await writePrivateRecord(resolveOwnedPath(dataDir, "workspaces", key, "state.json"), { schemaVersion: 1, lanes: [lane("legacy", { workspaceKey: key })] });
  const index = await readFleetInventory(dataDir);
  assert.equal(index.lanes.length, 1);
  assert.equal(index.lanes[0].controlAvailable, false);
  assert.equal(index.projects[0].registered, false);
});

test("changed project locations cannot be silently adopted", async (t) => {
  const { dataDir, workspace, key, root } = await setup(t);
  await registerWorkspace(dataDir, workspace);
  await fs.rename(workspace, path.join(root, "moved"));
  await assert.rejects(resolveRegisteredWorkspace(dataDir, key));
});

test("corrupt workspace records produce visible warnings instead of disappearing silently", async (t) => {
  const { dataDir, workspace, key } = await setup(t);
  await registerWorkspace(dataDir, workspace);
  await writePrivateRecord(resolveOwnedPath(dataDir, "workspaces", key, "state.json"), { schemaVersion: 99, lanes: [] });
  const index = await readFleetInventory(dataDir);
  assert.equal(index.warnings[0].reason, "workspace-state-unreadable");
});

test("private records refuse symlinks, oversized files and malformed UTF-8", async (t) => {
  const { root } = await setup(t);
  const record = path.join(root, "record.json");
  await fs.writeFile(record, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readPrivateRecord(record));
  await fs.writeFile(record, '"' + "x".repeat(50) + '"');
  await assert.rejects(readPrivateRecord(record, { maxBytes: 10 }));
  if (process.platform !== "win32") {
    const alias = path.join(root, "link.json"); await fs.symlink(record, alias);
    await assert.rejects(readPrivateRecord(alias));
    await assert.rejects(writePrivateRecord(alias, {}));
  }
});

test("record writes are atomic and exclusive transactions release their lock on failure", async (t) => {
  const { root } = await setup(t); const file = path.join(root, "record.json");
  await assert.rejects(withPrivateRecordLock(file, async () => { throw new Error("fixture failure"); }));
  await withPrivateRecordLock(file, () => writePrivateRecord(file, { a: 1 }));
  assert.deepEqual(await readPrivateRecord(file), { a: 1 });
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), []);
});

test("saved views round-trip and reject concurrent lost updates", async (t) => {
  const { dataDir, key } = await setup(t); const initial = await readConsolePreferences(dataDir, key);
  const state = { schemaVersion: 1, current: normalizeConsoleView({ scope: "projects", groupMode: "project", favorites: ["agent"], collapsedGroups: ['group:project:["P"]'] }), savedViews: [] };
  const writes = await Promise.allSettled([writeConsolePreferences(dataDir, key, state, initial.revision), writeConsolePreferences(dataDir, key, state, initial.revision)]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readConsolePreferences(dataDir, key)).current.scope, "projects");
});

test("view normalization rejects control characters and bounds collections", () => {
  const normalized = normalizeConsoleView({ scope: "secret", groupMode: "bogus", filterQuery: "a\u001bb", favorites: new Array(1000).fill("same"), collapsedGroups: ["bad\u009b"] });
  assert.equal(normalized.scope, "workspace"); assert.equal(normalized.groupMode, "flat");
  assert.equal(normalized.filterQuery, ""); assert.deepEqual(normalized.favorites, ["same"]); assert.deepEqual(normalized.collapsedGroups, []);
});

test("attention ordering and pinned agents are stable and never mutate input", () => {
  const records = [lane("done", { status: "complete" }), lane("blocked", { status: "blocked" }), lane("run")];
  assert.deepEqual(sortConsoleLanes(records, "attention").map((item) => item.id), ["blocked", "run", "done"]);
  assert.equal(sortConsoleLanes(records, "attention", ["done"])[0].id, "done");
  assert.equal(records[0].id, "done");
});

test("native inventory explicitly queries every source kind and paginates without resume", async () => {
  const calls = [];
  const inventory = await discoverNativeThreads(async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [native("child", { source: { subAgent: "review" }, parentThreadId: "native-a" })], nextCursor: null }
      : { data: [native()], nextCursor: "page2" };
  });
  assert.equal(inventory.lanes.length, 2);
  assert.equal(inventory.lanes[1].parentThreadId, "native-a");
  assert.deepEqual(calls[0].params.sourceKinds, NATIVE_SOURCE_KINDS);
  assert.ok(calls.every((call) => call.method === "thread/list" && call.params.useStateDbOnly));
  assert.ok(inventory.lanes.every((item) => item.controlAvailable === false));
});

test("native inventory does not disclose preview prompts or treat managed children as owned", () => {
  const item = normalizeNativeThread(native("known", { name: null, preview: "PRIVATE USER PROMPT", parentThreadId: "parent" }), new Map([["known", { id: "managed" }]]));
  assert.ok(!JSON.stringify(item).includes("PRIVATE USER PROMPT"));
  assert.equal(item.controlAvailable, false); assert.equal(item.managedLaneId, "managed");
});

test("native pagination rejects malformed or repeated cursors and reports bounded truncation", async () => {
  await assert.rejects(discoverNativeThreads(async () => ({ data: [], nextCursor: "same" })), /repeating/);
  assert.equal((await discoverNativeThreads(async () => ({ data: [], nextCursor: "next" }), { maxPages: 1 })).truncated, true);
  await assert.rejects(discoverNativeThreads(async () => ({ data: [native("bad id")], nextCursor: null })), /identifier/);
});

test("inventory cursors are snapshot-bound and filters include project/source/parent", () => {
  const original = { lanes: [lane("one", { project: "Alpha", source: "fleet", parentThreadId: "root" }), lane("two", { project: "Alpha", source: "fleet" })] };
  const first = paginateInventory(original, { limit: 1, query: "project:Alpha source:fleet" });
  assert.equal(first.lanes[0].id, "one");
  assert.equal(paginateInventory(original, { limit: 1, query: "project:Alpha source:fleet", cursor: first.nextCursor }).lanes[0].id, "two");
  assert.equal(paginateInventory(original, { query: "parent:root" }).total, 1);
  assert.throws(() => paginateInventory({ lanes: original.lanes.slice(1) }, { cursor: first.nextCursor }), /changed/);
});

test("global control routes by trusted project registration, never a row-supplied path", async (t) => {
  const { dataDir, workspace, root } = await setup(t);
  const other = path.join(root, "other"); await fs.mkdir(other);
  const registration = await registerWorkspace(dataDir, other);
  const requests = [], starts = [];
  const runtime = await createSupervisorRuntime({ cwd: workspace, env: { XDG_STATE_HOME: root, LOCALAPPDATA: root }, home: root,
    ensureSupervisor: async (options) => { starts.push(options); return { address: "fixture", token: "a".repeat(64) }; },
    requestSupervisor: async (request) => { requests.push(request); return {}; } });
  // The real runtime computes a conventional data root, not arbitrary caller dataDir.
  const actualData = getFleetDataDir({ XDG_STATE_HOME: root, LOCALAPPDATA: root }, process.platform, root);
  await registerWorkspace(actualData, other);
  await runtime.message({ id: `${registration.workspaceKey}:agent`, controlId: "agent", originWorkspaceKey: registration.workspaceKey, workspacePath: "/hostile", controlAvailable: true }, "Inspect");
  assert.equal(starts[0].workspacePath, await fs.realpath(other));
  assert.equal(requests[0].params.laneId, "agent");
});

test("observed sessions can be inspected but never messaged, followed up or cancelled", async () => {
  const calls = [];
  const runtime = await createSupervisorRuntime({ ensureSupervisor: async () => ({ address: "fixture", token: "a".repeat(64) }), requestSupervisor: async (request) => { calls.push(request); return {}; } });
  const item = normalizeNativeThread(native());
  await runtime.session(item);
  await assert.rejects(runtime.message(item, "No"), { code: "AUTHORITY_DENIED" });
  await assert.rejects(runtime.followUp(item, "No"), { code: "AUTHORITY_DENIED" });
  await assert.rejects(runtime.cancel(item, { threadId: item.threadId, turnId: null }), { code: "AUTHORITY_DENIED" });
  assert.deepEqual(calls.map((call) => call.method), ["observeSession"]);
});

test("native runtime listing does not trigger turn/start or thread/resume", async () => {
  const calls = [];
  const runtime = new FleetRuntime({ protocolVersion: 1, setEventHandler() {}, async request(method) { calls.push(method); return { data: [native()], nextCursor: null }; } });
  assert.equal((await runtime.listThreads()).lanes.length, 1);
  assert.deepEqual(calls, ["thread/list", "thread/loaded/list"]);
});

test("renderer preserves global identity and labels observed threads honestly", () => {
  const id = "a".repeat(32) + ":" + "b".repeat(64);
  const view = buildViewModel(snapshot([lane(id), normalizeNativeThread(native())]), id);
  assert.equal(view.selectedLane.id, id);
  const observed = buildViewModel(snapshot([normalizeNativeThread(native())]), 0);
  assert.equal(observed.selectedLane.status, "observed");
  assert.match(renderScreen(observed, { columns: 160, rows: 30 }, { color: false }), /OBSERVATION ONLY/);
});

test("palette executes local commands and never dispatches text as model messages", async () => {
  const calls = [], controller = createConsoleController({ snapshot: snapshot(), runtime: { async message() { calls.push("message"); } } });
  let result = await controller.dispatch({ type: "palette" }); assert.equal(result.textMode, "palette");
  await controller.dispatch({ type: "text", value: "attention" });
  await controller.dispatch({ type: "applyFilter" });
  assert.equal(controller.state().sort, "attention"); assert.equal(controller.state().overlay, null);
  assert.deepEqual(calls, []);
});

test("native session has no composer and quit returns to dashboard", async () => {
  const item = normalizeNativeThread(native());
  const controller = createConsoleController({ snapshot: snapshot([item]), runtime: { async session() { return { messages: [], observationOnly: true }; } } });
  await controller.dispatch({ type: "activate" });
  assert.equal(controller.state().composer, null);
  await controller.dispatch({ type: "quit" });
  assert.equal(controller.state().session, null); assert.equal(controller.state().exitRequested, false);
});

test("scope switch discards old rows before control can be sent", async () => {
  const controller = createConsoleController({ snapshot: snapshot(), readSnapshot: async () => new Promise(() => {}), refreshTimeoutMs: 5 });
  await controller.dispatch({ type: "scope" });
  assert.equal(controller.state().scope, "projects"); assert.equal(controller.state().selectedLaneId, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("saved-view changes are persisted without inference and can be loaded", async () => {
  let saved;
  const controller = createConsoleController({ snapshot: snapshot(), saveViewState: async (value) => { saved = value; } });
  await controller.dispatch({ type: "favorite" });
  await controller.dispatch({ type: "groupMode" });
  await controller.saveState();
  assert.deepEqual(saved.current.favorites, ["agent"]); assert.equal(saved.current.groupMode, "folder");
  const restored = createConsoleController({ snapshot: snapshot(), savedViewState: saved });
  assert.equal(restored.state().groupMode, "folder");
});

test("operator overlays fit Unicode, narrow and monochrome terminal dimensions", () => {
  for (const [columns, rows] of [[1, 1], [32, 8], [60, 18], [100, 28], [160, 40]]) {
    const text = renderOperatorOverlay({ kind: "palette", query: "", index: 12 }, { columns, rows });
    assert.ok(text.split("\n").length <= rows);
    assert.ok(text.split("\n").every((line) => displayWidth(stripAnsi(line)) <= columns));
  }
});

test("new operator keys stay text while composing", () => {
  const decoder = createInputDecoder();
  assert.deepEqual(decoder.push(":waf").map((event) => event.type), ["palette", "scope", "attention", "favorite"]);
  decoder.setTextMode("composer");
  assert.ok(decoder.push(":waf").every((event) => event.type === "text"));
});

test("inventory CLI supports explicit registration and bounded global reads", async (t) => {
  const { root, workspace } = await setup(t);
  const output = [], errors = [];
  const options = { cwd: workspace, env: { XDG_STATE_HOME: root, LOCALAPPDATA: root }, platform: process.platform, home: root, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };
  assert.equal(await runCli(["register", "--workspace", workspace, "--json"], options), 0, errors.join(""));
  output.length = 0;
  assert.equal(await runCli(["projects", "--json"], options), 0, errors.join(""));
  assert.equal(JSON.parse(output.join("")).projects.length, 1);
  output.length = 0;
  assert.equal(await runCli(["inventory", "--json", "--limit", "1"], options), 0, errors.join(""));
  assert.equal(JSON.parse(output.join("")).total, 0);
});

test("ephemeral native children are discovered through metadata-only loaded-thread reads", async () => {
  const calls = [];
  const result = await discoverNativeThreads(async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/list") return { data: [native("root")], nextCursor: null };
    if (method === "thread/loaded/list") return { data: ["root", "ephemeral"], nextCursor: null };
    return { thread: native("ephemeral", { parentThreadId: "root", ephemeral: true }) };
  }, { includeLoaded: true });
  assert.deepEqual(result.lanes.map((item) => item.threadId), ["root", "ephemeral"]);
  assert.deepEqual(calls.at(-1), { method: "thread/read", params: { threadId: "ephemeral", includeTurns: false } });
  assert.equal(result.lanes[1].controlAvailable, false);
});

test("a missing loaded-thread capability is a visible inventory warning", async () => {
  const result = await discoverNativeThreads(async (method) => {
    if (method === "thread/list") return { data: [], nextCursor: null };
    throw new Error("not supported");
  }, { includeLoaded: true });
  assert.equal(result.warnings[0].reason, "loaded-inventory-unavailable");
});

test("supervisor inventory pages are byte bounded, not just count bounded", () => {
  const index = { lanes: Array.from({ length: 100 }, (_, n) => lane(`a${n}`, { label: "x".repeat(3000) })) };
  const page = paginateInventory(index, { limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
  assert.ok(page.nextCursor);
});

 test("real decoder stays in palette text mode instead of firing dashboard shortcuts", async () => {
  const controller = createConsoleController({ snapshot: { lanes: [lane("run")] }, write() {} });
  const decoder = createInputDecoder();
  for (const character of ":attention") {
    for (const event of decoder.push(character)) {
      const result = await controller.dispatch(event); decoder.setTextMode(result.textMode);
    }
  }
  for (const event of decoder.push("\r")) await controller.dispatch(event);
  assert.equal(controller.viewState().current.sort, "attention");
 });
