#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildViewModel,
  renderScreen
} from "../plugins/fleet/scripts/lib/tui-render.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputRoot = path.join(root, "tests", "golden");
const now = "2026-08-17T12:00:00.000Z";

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
    updatedAt: now,
    resultRef: "results/runtime-audit.json",
    evidenceRefs: ["evidence/runtime-contract.json"],
    tokenUsage: null,
    ...overrides
  };
}

const snapshot = {
  schemaVersion: 1,
  workspace: { name: "codex-fleet-cc", branch: "main" },
  runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
  updatedAt: now,
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
  ]
};

const view = buildViewModel(snapshot, "console-build", "lanes");
const cases = [
  ["wide", 160, { color: false, unicode: true, frame: 0 }],
  ["compact", 100, { color: false, unicode: true, frame: 0 }],
  ["narrow", 72, { color: false, unicode: true, frame: 0 }],
  ["mono", 100, { color: false, unicode: false, monochrome: true, frame: 0 }]
];

await fs.mkdir(outputRoot, { recursive: true });
for (const [name, columns, preferences] of cases) {
  const output = renderScreen(view, { columns, rows: 28 }, preferences);
  await fs.writeFile(path.join(outputRoot, `${name}.txt`), `${output}\n`, "utf8");
  process.stdout.write(`updated tests/golden/${name}.txt\n`);
}
