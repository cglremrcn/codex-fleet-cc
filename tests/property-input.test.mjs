import assert from "node:assert/strict";
import test from "node:test";

import {
  buildViewModel,
  renderScreen
} from "../plugins/fleet/scripts/lib/tui-render.mjs";

function hostileText(index) {
  const fragments = [
    "\u0000\u001b[31mCONTROL",
    "e\u0301界🟢",
    "../private\\workspace",
    "A".repeat(2_048),
    "\ud800unpaired"
  ];
  return `${fragments[index % fragments.length]}-${index}`;
}

function fixture(index) {
  const snapshot = {
    schemaVersion: 1,
    workspace: { name: hostileText(index), branch: hostileText(index + 1) },
    runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
    lanes: [{
      id: `lane-${index}`,
      role: hostileText(index + 2),
      label: hostileText(index + 3),
      model: "gpt-5.6-sol",
      effort: "high",
      status: index % 2 === 0 ? "running" : "complete",
      phase: hostileText(index + 4),
      authority: { sandbox: "read-only", network: "off" }
    }]
  };
  return buildViewModel(snapshot, 0, "lanes");
}

test("renderer survives hostile dimensions and Unicode deterministically", () => {
  const dimensions = [
    { columns: -1, rows: -1 },
    { columns: 0, rows: 0 },
    { columns: 1, rows: 1 },
    { columns: 39, rows: 8 },
    { columns: 72, rows: 24 },
    { columns: 160, rows: 80 },
    { columns: 240, rows: 120 }
  ];

  for (let index = 0; index < 1_000; index += 1) {
    const terminal = dimensions[index % dimensions.length];
    assert.doesNotThrow(() => renderScreen(fixture(index), terminal, {
      color: index % 2 === 0,
      unicode: index % 3 !== 0,
      reducedMotion: index % 5 === 0,
      frame: index
    }));
  }
});
