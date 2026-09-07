#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  buildViewModel,
  renderScreen
} from "../plugins/fleet/scripts/lib/tui-render.mjs";

import { buildLaneNavigation } from "../plugins/fleet/scripts/lib/lane-navigation.mjs";

const project = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
const version = project.version;

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
    groupPath: "Runtime",
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
    groupPath: "Console",
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
    groupPath: "Console",
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
    groupPath: "Runtime",
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
  workspace: { name: "codex-fleet-cc", branch: "synthetic-preview" },
  runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
  updatedAt: "2026-09-07T12:00:00.000Z",
  lanes
};
const navigation = buildLaneNavigation(lanes, { mode: "folder" });
const dashboardView = buildViewModel(snapshot, "console-build", "detail", {
  navigationRows: navigation.rows
});
const sessionView = buildViewModel(snapshot, "runtime-audit", "detail");

const frames = Array.from({ length: 4 }, (_, frame) => renderScreen(
  dashboardView,
  { columns: 160, rows: 28 },
  { color: true, unicode: true, frame, version }
));

const sessionFrame = renderScreen(
  sessionView,
  { columns: 140, rows: 30 },
  {
    color: true,
    unicode: true,
    frame: 1,
    version,
    session: {
      laneId: "runtime-audit",
      threadId: "0198-sanitized-thread",
      source: "appServer",
      admissionId: "71177e04-sanitized-admission",
      admissionSource: "fleet-supervisor",
      admittedAt: "2026-08-20T02:11:01.799Z",
      canAcceptDirectInput: true,
      messages: [
        {
          kind: "user",
          text: "Inspect native-thread ownership and the shared inbox boundary."
        },
        {
          kind: "assistant",
          text: "Native threads remain observe-only. Inbox actions require a current Fleet-owned turn and an exact human-reviewed preview."
        },
        {
          kind: "activity",
          text: "SOURCE REVIEW · synthetic evidence fixture"
        }
      ],
      scroll: 0
    },
    composer: { laneId: "runtime-audit", value: "Recheck the same-turn approval boundary independently." },
    notice: "SAME CODEX THREAD · READY FOR FOLLOW-UP"
  }
);

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  fixture: "Deterministic synthetic data; current production renderer; no live account.",
  version,
  previews: {
    dashboard: { columns: 160, rows: 28, frames },
    session: { columns: 140, rows: 30, frame: sessionFrame }
  }
}));
