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

test("masthead identifies the integration runtime that is actually loaded", () => {
  const output = stripAnsi(renderScreen(
    viewFixture(),
    { columns: 120, rows: 28 },
    plainPreferences({ version: "0.1.6" })
  ));

  assert.match(output, /FLEET\/\/OPS\s+v0\.1\.6/);
});

test("operator chrome exposes named destinations without internal panel counters", () => {
  const output = stripAnsi(renderScreen(
    viewFixture({ panel: "detail" }),
    { columns: 160, rows: 28 },
    plainPreferences({ version: "0.1.6" })
  ));

  assert.doesNotMatch(output, /NAV\/\/KITE|POSTURE|\bPANEL\s+\w+\s+\d+\/5/iu);
  assert.match(output, /Tab: Detail → Evidence → Authority/iu);
  assert.match(output, /\/: Search lanes/iu);
});

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

test("interrupted lanes are visible controller-attention states", () => {
  const view = viewFixture({
    selection: "lost-supervisor",
    snapshot: {
      lanes: [lane({
        id: "lost-supervisor",
        status: "interrupted",
        phase: "interrupted"
      })]
    }
  });
  const output = stripAnsi(renderScreen(
    view,
    { columns: 120, rows: 28 },
    plainPreferences({ unicode: false })
  ));

  assert.equal(view.totals.interrupted, 1);
  assert.equal(view.totals.attention, 1);
  assert.match(output, /INTERRUPTED/iu);
  assert.match(output, /controller reconciliation/iu);
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

test("runtime recovery and controller requests are visible without opening logs", () => {
  const recovering = stripAnsi(renderScreen(
    viewFixture({
      snapshot: {
        lanes: [lane({
          status: "running",
          phase: "recovering 1/2",
          automaticContinuations: 1
        })]
      }
    }),
    { columns: 160, rows: 28 },
    plainPreferences()
  ));
  assert.match(recovering, /AUTO RECOVERY\s+1\/2/iu);

  const blocked = stripAnsi(renderScreen(
    viewFixture({
      snapshot: {
        lanes: [lane({
          status: "blocked",
          phase: "needs-controller",
          controllerRequest: {
            kind: "new_authority",
            question: "Production deployment authority is required."
          }
        })]
      }
    }),
    { columns: 160, rows: 28 },
    plainPreferences()
  ));
  assert.match(blocked, /CONTROLLER REQUEST/iu);
  assert.match(blocked, /Production deployment authority/iu);
});

test("structured work, verification, and artifacts appear in the evidence panel", () => {
  const output = stripAnsi(renderScreen(
    viewFixture({
      panel: "evidence",
      snapshot: {
        lanes: [lane({
          status: "complete",
          outcome: "accomplished",
          workPerformed: ["Updated the runtime adapter."],
          verification: ["Focused tests passed."],
          artifactRefs: ["src/runtime.mjs"]
        })]
      }
    }),
    { columns: 100, rows: 28 },
    plainPreferences()
  ));

  assert.match(output, /WORK PERFORMED/iu);
  assert.match(output, /Updated the runtime adapter/iu);
  assert.match(output, /VERIFICATION/iu);
  assert.match(output, /Focused tests passed/iu);
  assert.match(output, /ARTIFACT REFS/iu);
  assert.match(output, /src\/runtime\.mjs/iu);
});

test("complete awaits verification with motion while verified remains locked", () => {
  const completeView = viewFixture({
    selection: "runtime-audit",
    snapshot: { lanes: [lane({ status: "complete" })] }
  });
  const verifiedView = viewFixture({
    selection: "release-proof",
    snapshot: { lanes: [lane({ id: "release-proof", status: "verified" })] }
  });

  assert.notDeepEqual(
    renderFleetMark(completeView, { frame: 0, unicode: true }),
    renderFleetMark(completeView, { frame: 1, unicode: true })
  );
  assert.notDeepEqual(
    renderFleetMark(completeView, { frame: 0, unicode: true }).slice(2),
    renderFleetMark(completeView, { frame: 1, unicode: true }).slice(2)
  );
  assert.deepEqual(
    renderFleetMark(verifiedView, { frame: 0, unicode: true }),
    renderFleetMark(verifiedView, { frame: 1, unicode: true })
  );
});

test("embedded Codex session renders real transcript, provenance, and composer", () => {
  const output = stripAnsi(renderScreen(
    viewFixture({ selection: "runtime-audit" }),
    { columns: 120, rows: 28 },
    plainPreferences({
      session: {
        laneId: "runtime-audit",
        threadId: "0198-thread-proof",
        source: "appServer",
        admissionId: "71177e04-admission-proof",
        admissionSource: "fleet-supervisor",
        admittedAt: "2026-08-19T20:25:00.000Z",
        canAcceptDirectInput: true,
        messages: [
          { kind: "user", text: "Check the exact source claim." },
          { kind: "assistant", text: "The source supports only a narrower claim." },
          { kind: "activity", text: "WEB SEARCH · Citroen C4 launch" }
        ],
        scroll: 0
      },
      composer: { laneId: "runtime-audit", value: "" },
      notice: "MESSAGE SENT · runtime-audit · SAME CODEX THREAD"
    })
  ));

  assert.match(output, /CODEX SESSION/iu);
  assert.match(output, /THREAD 0198-thread-proof/iu);
  assert.match(output, /SOURCE appServer/iu);
  assert.match(output, /ADMISSION 71177e04-admission-proof/iu);
  assert.match(output, /fleet-supervisor.*2026-08-19T20:25:00.000Z/iu);
  assert.match(output, /\[YOU\].*Check the exact source claim\./u);
  assert.match(output, /\[CODEX\].*narrower claim\./u);
  assert.doesNotMatch(output, /\[ACTIVITY\].*WEB SEARCH/u);
  assert.match(output, /ACTIVITY\s+1 event hidden/iu);
  assert.match(output, /MESSAGE SENT · runtime-audit · SAME CODEX THREAD/u);
  assert.match(output, /FOLLOW-UP/iu);
  assert.match(output, /Enter: Send.*Ctrl\+G: Dashboard/iu);
});

test("session scroll clamps at the oldest transcript instead of rendering blank", () => {
  const output = stripAnsi(renderScreen(
    viewFixture({ selection: "runtime-audit" }),
    { columns: 100, rows: 18 },
    plainPreferences({
      session: {
        laneId: "runtime-audit",
        threadId: "thread-scroll",
        source: "appServer",
        canAcceptDirectInput: true,
        messages: [
          { kind: "user", text: "Oldest retained message." },
          { kind: "assistant", text: "Middle retained message." },
          { kind: "assistant", text: "Newest retained message." }
        ],
        scroll: 999
      },
      composer: { laneId: "runtime-audit", value: "" }
    })
  ));

  assert.match(output, /Oldest retained message\./u);
  assert.match(output, /TRANSCRIPT · OLDEST/iu);
});

test("session slash prefix opens a clearly local command palette", () => {
  const output = stripAnsi(renderScreen(
    viewFixture({ selection: "runtime-audit" }),
    { columns: 120, rows: 24 },
    plainPreferences({
      session: {
        laneId: "runtime-audit",
        threadId: "thread-command",
        source: "appServer",
        canAcceptDirectInput: true,
        messages: [],
        scroll: 0
      },
      composer: { laneId: "runtime-audit", value: "/" }
    })
  ));

  assert.match(output, /FLEET LOCAL COMMANDS/iu);
  assert.match(output, /\/latest/iu);
  assert.match(output, /\/activity/iu);
  assert.match(output, /\/back/iu);
});

test("wide and compact layouts render every focused panel visibly", () => {
  for (const columns of [160, 100]) {
    for (const panel of ["detail", "evidence", "authority"]) {
      const output = stripAnsi(renderScreen(
        viewFixture({ panel }),
        { columns, rows: 28 },
        plainPreferences()
      ));
      assert.match(output, new RegExp(`\\[${panel.toUpperCase()}\\]`, "u"));
    }
  }
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
    assert.match(output, /Enter: Open agent/iu);
    assert.match(output, /X: Cancel/iu);
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
