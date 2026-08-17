#!/usr/bin/env node

import {
  buildViewModel,
  renderScreen
} from "../plugins/fleet/scripts/lib/tui-render.mjs";

const authority = (overrides = {}) => ({
  sandbox: "read-only",
  network: "off",
  browser: { inspect: false, mutate: false },
  process: { start: false, stopOwned: false },
  database: { read: false, write: false },
  externalEffects: { send: false, payment: false, deploy: false, delete: false },
  retry: false,
  ...overrides
});

const lanes = [
  {
    id: "runtime-audit",
    role: "investigator",
    label: "Inspect the Codex runtime boundary",
    model: "gpt-5.6-sol",
    effort: "high",
    status: "complete",
    phase: "evidence",
    authority: authority(),
    resultRef: "results/runtime-audit.json",
    evidenceRefs: ["evidence/runtime-contract.json"],
    tokenUsage: null
  },
  {
    id: "console-build",
    role: "implementer",
    label: "Build the responsive operator console",
    model: "gpt-5.6-sol",
    effort: "high",
    status: "running",
    phase: "renderer",
    authority: authority({ sandbox: "workspace-write" }),
    resultRef: null,
    evidenceRefs: [],
    tokenUsage: { input: 1842, output: 612 }
  },
  {
    id: "qa-browser",
    role: "browser-qa-operator",
    label: "Verify the same-session terminal handoff",
    model: "gpt-5.6-sol",
    effort: "high",
    status: "blocked",
    phase: "waiting-for-pty",
    authority: authority({ browser: { inspect: true, mutate: false } }),
    resultRef: null,
    evidenceRefs: [],
    tokenUsage: null
  },
  {
    id: "release-proof",
    role: "independent-verifier",
    label: "Verify package evidence independently",
    model: "gpt-5.6-sol",
    effort: "high",
    status: "verified",
    phase: "verified",
    authority: authority(),
    verifierLaneId: "verifier-fresh",
    resultRef: "results/release-proof.json",
    evidenceRefs: ["evidence/release-proof.json"],
    tokenUsage: null
  }
];

const snapshot = {
  schemaVersion: 1,
  workspace: { name: "codex-fleet-cc", branch: "main" },
  runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
  updatedAt: "2026-08-17T12:00:00.000Z",
  lanes
};
const view = buildViewModel(snapshot, "console-build", "lanes");

const frames = Array.from({ length: 4 }, (_, frame) => renderScreen(
  view,
  { columns: 160, rows: 28 },
  { color: true, unicode: true, frame }
));

process.stdout.write(JSON.stringify({ columns: 160, rows: 28, frames }));
