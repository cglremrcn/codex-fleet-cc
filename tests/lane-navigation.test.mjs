import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { buildLaneNavigation, filterLanes, validateGroupPath, GROUP_MODES } from "../plugins/fleet/scripts/lib/lane-navigation.mjs";
import { createConsoleController } from "../plugins/fleet/scripts/lib/console-controller.mjs";
import { createInputDecoder } from "../plugins/fleet/scripts/lib/tui-input.mjs";
import { buildViewModel, renderScreen, displayWidth } from "../plugins/fleet/scripts/lib/tui-render.mjs";
import { createLane } from "../plugins/fleet/scripts/lib/domain.mjs";

const key = "a".repeat(32);
function lanes(count = 100) {
  return Array.from({ length: count }, (_, i) => ({
    id: `lane-${i}`, role: i % 2 ? "investigator" : "implementer", label: `Review task ${i}`,
    workspaceKey: key, checkoutKey: i % 2 ? "isolated-b" : "isolated-a", groupPath: `project-${i % 4}/task-${i % 8}`,
    model: i % 2 ? "worker-b" : "worker-a", effort: "high", status: i % 3 ? "running" : "complete",
    phase: "inspect", authority: { sandbox: "read-only", network: "off", process: { start: true, stopOwned: true } }
  }));
}
function fixture(rows = lanes()) {
  return { schemaVersion: 1, workspace: { name: "test", branch: "main" }, lanes: rows };
}

test("compound literal filters support AND, comma OR, negation and quoted values", () => {
  const rows = lanes();
  assert.equal(filterLanes(rows, 'status:running role:implementer -folder:project-2').length,
    rows.filter(l => l.status === "running" && l.role === "implementer" && !l.groupPath.includes("project-2")).length);
  assert.equal(filterLanes(rows, 'status:running,complete label:"Review task"').length, 100);
  assert.equal(filterLanes(rows, 'checkout:isolated-a model:worker-a effort:high').length, 50);
  assert.equal(filterLanes(rows, 'unknown:value').length, 0);
  assert.equal(filterLanes(rows, '[a-z].*').length, 0);
  assert.equal(filterLanes(rows, 'label:').length, 0);
});

test("all grouping modes retain every agent and do not mutate input", () => {
  const rows = lanes(256); const original = JSON.stringify(rows);
  for (const mode of GROUP_MODES) {
    const nav = buildLaneNavigation(rows, { mode });
    assert.equal(nav.lanes.length, 256);
    assert.equal(nav.rows.filter(r => r.kind !== "group").length, 256);
    assert.equal(new Set(nav.rows.map(r => r.id)).size, nav.rows.length);
  }
  assert.equal(JSON.stringify(rows), original);
});

test("nested folders collapse without losing global counts or changing agent IDs", () => {
  const rows = lanes(); const expanded = buildLaneNavigation(rows, { mode: "folder" });
  const first = expanded.groups.find(g => g.depth === 0);
  const nav = buildLaneNavigation(rows, { mode: "folder", collapsed: new Set([first.id]) });
  assert.equal(nav.lanes.length, 100);
  assert.equal(nav.rows.filter(r => r.kind !== "group").length, 100 - first.count);
  assert.equal(nav.rows.find(r => r.id === first.id).collapsed, true);
  assert.ok(first.active > 0);
  assert.ok(expanded.groups.every(g => g.active <= g.count && g.attention <= g.count));
});

test("native parent grouping separates siblings by their reported parent thread", () => {
  const rows = [
    { id: "codex:root", parentThreadId: null },
    { id: "codex:child-a", parentThreadId: "root" },
    { id: "codex:child-b", parentThreadId: "root" },
    { id: "codex:other-child", parentThreadId: "other-root" }
  ];
  const expanded = buildLaneNavigation(rows, { mode: "parent" });
  const siblings = expanded.groups.find((group) => group.label === "root");
  assert.ok(siblings, "reported parent must become a group");
  assert.equal(siblings.count, 2);
  assert.equal(expanded.groups.length, 3);
  const folded = buildLaneNavigation(rows, { mode: "parent", collapsed: new Set([siblings.id]) });
  assert.deepEqual(folded.rows.filter((row) => row.kind !== "group").map((row) => row.id).sort(),
    ["codex:other-child", "codex:root"]);
  assert.equal(folded.lanes.length, 4);
});

test("group identifiers cannot collide with admitted lane identifiers", () => {
  const row = lanes(1)[0]; const group = buildLaneNavigation([row], { mode: "folder" }).groups[0];
  assert.throws(() => createLane({ ...row, id: group.id }), /Lane id/);
  assert.equal(createLane(row).groupPath, row.groupPath);
});

for (const invalid of ["", "/tmp", "a/../b", "a/./b", "a//b", "a/", "a\\b", "C:/secret", "a/ b", "a\u001bb", "a\u009bb", "a\u202eb", "x/".repeat(9) + "x", "x".repeat(161), null]) {
  test(`reject unsafe logical folder ${JSON.stringify(invalid)}`, () => assert.throws(() => validateGroupPath(invalid)));
}

test("missing and malformed legacy folders remain observable as Ungrouped", () => {
  const nav = buildLaneNavigation([{ ...lanes(1)[0], groupPath: "../private" }], { mode: "folder" });
  assert.equal(nav.groups[0].label, "Ungrouped");
  assert.equal(nav.lanes.length, 1);
  assert.equal(validateGroupPath("ön yüz/ödeme 🧪"), "ön yüz/ödeme 🧪");
});

test("folder headers can never invoke runtime session, message or cancellation", async () => {
  const calls = [];
  const controller = createConsoleController({ snapshot: fixture(), terminal: { columns: 100, rows: 28 },
    preferences: { color: false, reducedMotion: true },
    runtime: Object.fromEntries(["session", "message", "cancel", "retry", "followUp"].map(key => [key, async () => calls.push(key)])) });
  await controller.dispatch({ type: "groupMode" });
  await controller.dispatch({ type: "home" });
  for (const type of ["activate", "cancel", "confirm", "message", "reconcile"]) await controller.dispatch({ type });
  assert.deepEqual(calls, []);
  assert.equal(controller.state().matchedLaneCount, 100);
  await controller.dispatch({ type: "collapseGroups" });
  assert.equal(controller.state().laneCount, 4);
  await controller.dispatch({ type: "expandGroups" });
  assert.ok(controller.state().laneCount > 100);
});

test("normal grouped leaf still opens its exact lane session", async () => {
  const calls = [];
  const row = lanes(1)[0];
  const controller = createConsoleController({ snapshot: fixture([row]),
    runtime: { session: async lane => { calls.push(lane.id); return { messages: [], threadId: "exact", canAcceptDirectInput: true }; } } });
  await controller.dispatch({ type: "groupMode" });
  await controller.dispatch({ type: "end" });
  await controller.dispatch({ type: "activate" });
  assert.deepEqual(calls, [row.id]);
});

test("search exposes matched/total agents rather than counting group headers", async () => {
  const controller = createConsoleController({ snapshot: fixture() });
  await controller.dispatch({ type: "groupMode" });
  await controller.dispatch({ type: "filter" });
  await controller.dispatch({ type: "text", value: "role:implementer" });
  await controller.dispatch({ type: "applyFilter" });
  assert.equal(controller.state().matchedLaneCount, 50);
  assert.equal(controller.state().totalLaneCount, 100);
});

test("grouped rendering fits narrow, compact, wide and monochrome terminals", () => {
  const snapshot = fixture(lanes(256));
  const nav = buildLaneNavigation(snapshot.lanes, { mode: "folder" });
  for (const columns of [40, 80, 100, 160]) {
    const view = buildViewModel(snapshot, nav.rows[0].id, "detail", { navigationRows: nav.rows, visibleLaneCapacity: 10 });
    assert.equal(view.selectedLane, null);
    assert.equal(view.totals.active, snapshot.lanes.filter(l => l.status === "running").length);
    const screen = renderScreen(view, { columns, rows: 28 }, { color: false, unicode: false, reducedMotion: true });
    assert.ok(screen.split("\n").every(line => displayWidth(line) <= columns));
  }
});

test("Unicode supplementary characters survive filter/composer decoding", () => {
  for (const mode of ["filter", "composer"]) {
    const decoder = createInputDecoder(); decoder.setTextMode(mode);
    assert.deepEqual(decoder.push(Buffer.from("🧪İ")), [{ type: "text", value: "🧪" }, { type: "text", value: "İ" }]);
    assert.deepEqual(decoder.push(Buffer.from("g []")), [..."g []"].map(value => ({ type: "text", value })));
  }
});

test("navigation generation stays bounded for 256 retained records", () => {
  const rows = lanes(256); const start = performance.now();
  for (let i = 0; i < 100; i++) buildLaneNavigation(rows, { mode: "folder", query: "-status:failed" });
  // Generous regression watchdog, not an advertised production performance promise.
  assert.ok(performance.now() - start < 5000);
});
