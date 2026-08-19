import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildViewModel,
  displayWidth,
  renderFleetMark,
  renderScreen,
  stripAnsi
} from "../plugins/fleet/scripts/lib/tui-render.mjs";

const NOW = "2026-08-17T12:00:00.000Z";

function authority(overrides = {}) {
  return {
    sandbox: "read-only",
    network: "off",
    browser: { inspect: false, mutate: false },
    process: { start: false, stopOwned: false },
    database: { read: false, write: false },
    externalEffects: { send: false, payment: false, deploy: false, delete: false },
    retry: false,
    ...overrides
  };
}

function lane(overrides = {}) {
  return {
    id: "runtime-audit",
    role: "investigator",
    label: "Inspect the Codex runtime boundary",
    model: "gpt-5.6-sol",
    effort: "high",
    status: "complete",
    phase: "evidence",
    authority: authority(),
    updatedAt: NOW,
    resultRef: "results/runtime-audit.json",
    evidenceRefs: ["evidence/runtime-contract.json"],
    tokenUsage: null,
    ...overrides
  };
}

function fleetSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    workspace: { name: "codex-fleet-cc", branch: "main" },
    runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
    updatedAt: NOW,
    lanes: [
      lane(),
      lane({
        id: "console-build",
        role: "implementer",
        label: "Build the responsive operator console",
        status: "running",
        phase: "renderer",
        authority: authority({ sandbox: "workspace-write" }),
        resultRef: null,
        evidenceRefs: [],
        tokenUsage: { input: 1842, output: 612 }
      }),
      lane({
        id: "qa-browser",
        role: "browser-qa-operator",
        label: "Verify the same-session terminal handoff",
        status: "blocked",
        phase: "waiting-for-pty",
        authority: authority({ browser: { inspect: true, mutate: false } }),
        resultRef: null,
        evidenceRefs: []
      }),
      lane({
        id: "release-proof",
        role: "independent-verifier",
        label: "Verify package evidence independently",
        status: "verified",
        phase: "verified",
        verifierLaneId: "verifier-fresh",
        evidenceRefs: ["evidence/release-proof.json"]
      })
    ],
    ...overrides
  };
}

function viewFixture(overrides = {}) {
  const snapshot = fleetSnapshot(overrides.snapshot);
  const selection = overrides.selection ?? "console-build";
  return buildViewModel(snapshot, selection, overrides.panel ?? "lanes");
}

function plainPreferences(overrides = {}) {
  return { color: false, unicode: true, screenReader: false, ...overrides };
}

for (const [name, columns] of [["wide", 160], ["compact", 100], ["narrow", 72]]) {
  test(`${name} layout stays inside the viewport`, () => {
    const output = stripAnsi(
      renderScreen(viewFixture(), { columns, rows: 28 }, { color: true, unicode: true })
    );
    const lines = output.split("\n");

    assert.ok(lines.length <= 28);
    assert.ok(lines.every((line) => displayWidth(line) <= columns));
    assert.match(output, /console-build/);
  });
}

test("renderer never invents token or verification data", () => {
  const output = stripAnsi(renderScreen(
    viewFixture({
      selection: "runtime-audit",
      snapshot: { lanes: [lane({ tokenUsage: null, status: "complete" })] }
    }),
    { columns: 120, rows: 24 },
    plainPreferences()
  ));

  assert.doesNotMatch(output, /0 tokens|VERIFIED/);
  assert.match(output, /COMPLETE/);
  assert.match(output, /Token usage not reported/);
});

test("semantic status survives monochrome output without color", () => {
  const output = renderScreen(
    viewFixture(),
    { columns: 100, rows: 28 },
    plainPreferences({ unicode: false, monochrome: true })
  );

  assert.doesNotMatch(output, /\u001b\[/);
  assert.match(output, /RUNNING/);
  assert.match(output, /BLOCKED/);
  assert.match(output, /VERIFIED/);
  assert.doesNotMatch(output, /[┌┐└┘│─━▶]/u);
});

test("display width handles ANSI, wide glyphs, combining marks, and emoji", () => {
  assert.equal(displayWidth("\u001b[36mFLEET\u001b[0m"), 5);
  assert.equal(displayWidth("İ"), 1);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("界"), 2);
  assert.equal(displayWidth("🟢"), 2);
});

test("Fleet Formation moves only when motion is enabled", () => {
  const movingA = renderFleetMark(viewFixture(), { frame: 0, unicode: true });
  const movingB = renderFleetMark(viewFixture(), { frame: 1, unicode: true });
  const reducedA = renderFleetMark(viewFixture(), {
    frame: 0,
    unicode: true,
    reducedMotion: true
  });
  const reducedB = renderFleetMark(viewFixture(), {
    frame: 3,
    unicode: true,
    reducedMotion: true
  });

  assert.notDeepEqual(movingA, movingB);
  assert.deepEqual(reducedA, reducedB);
  assert.equal(movingA.length, 5);
  assert.ok(movingA.every((line) => displayWidth(line) === 21));
});

test("KITE has a recognizable face and truthful state posture", () => {
  const running = renderFleetMark(viewFixture(), { frame: 0, unicode: true });
  const verified = renderFleetMark(viewFixture({
    selection: "release-proof"
  }), { frame: 0, unicode: true });
  const blocked = renderFleetMark(viewFixture({
    selection: "qa-browser"
  }), { frame: 0, unicode: true });

  assert.match(running.join("\n"), /●.*●/u);
  assert.match(verified.join("\n"), /⌒.*⌒/u);
  assert.match(verified.join("\n"), /✓/u);
  assert.match(blocked.join("\n"), /─.*─/u);
  assert.match(blocked.join("\n"), /!/u);
  assert.notDeepEqual(running, verified);
  assert.notDeepEqual(verified, blocked);
});

test("compact masthead keeps complete health counters", () => {
  const output = stripAnsi(renderScreen(
    viewFixture(),
    { columns: 100, rows: 28 },
    plainPreferences()
  ));

  const [workspaceLine, healthLine] = output.split("\n");
  assert.match(workspaceLine, /codex-fleet-cc@main/);
  assert.match(healthLine, /01 LIVE/);
  assert.match(healthLine, /01 VERIFIED/);
  assert.match(healthLine, /01 ATTENTION/);
  assert.doesNotMatch(healthLine, /…/);
});

test("every layout exposes follow-up and cancel controls without hidden help", () => {
  for (const columns of [160, 100, 72]) {
    const output = stripAnsi(renderScreen(
      viewFixture(),
      { columns, rows: 28 },
      plainPreferences()
    ));
    assert.match(output, /M (?:FOLLOW-UP|MESSAGE)/);
    assert.match(output, /X CANCEL/);
  }
});

test("screen-reader mode is linear and excludes decorative formation output", () => {
  const output = renderScreen(
    viewFixture(),
    { columns: 100, rows: 28 },
    { color: true, unicode: true, screenReader: true, motion: true, frame: 2 }
  );

  assert.doesNotMatch(output, /\u001b\[/);
  assert.doesNotMatch(output, /KITE|◆|◇|╲|╱|▼|●|╾|╼/u);
  assert.match(output, /Lane 2 of 4: console-build, running/);
});

test("view model preserves truthful status and chooses an existing lane", () => {
  const view = buildViewModel(fleetSnapshot(), "missing-lane", "authority");

  assert.equal(view.selectedLane.id, "runtime-audit");
  assert.equal(view.selectedLane.status, "complete");
  assert.equal(view.totals.verified, 1);
  assert.equal(view.totals.active, 1);
  assert.equal(Object.isFrozen(view), true);
});

for (const [name, columns, preferences] of [
  ["wide", 160, plainPreferences()],
  ["compact", 100, plainPreferences()],
  ["narrow", 72, plainPreferences()],
  ["mono", 100, plainPreferences({ unicode: false, monochrome: true })]
]) {
  test(`${name} golden stays stable`, async () => {
    const actual = renderScreen(viewFixture(), { columns, rows: 28 }, preferences);
    const expected = (
      await readFile(new URL(`./golden/${name}.txt`, import.meta.url), "utf8")
    ).replace(/\r\n?/g, "\n");
    assert.equal(`${actual}\n`, expected);
  });
}
