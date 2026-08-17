import assert from "node:assert/strict";
import test from "node:test";

import { runDoctor } from "../plugins/fleet/scripts/lib/doctor.mjs";

test("doctor distinguishes discovery, configuration, smoke, denial, and unknown", async () => {
  const report = await runDoctor({
    commandProbe: async (name) => ({ available: true, version: `${name}-1.0` }),
    authProbe: async () => ({ configured: true }),
    brokerProbe: async () => ({ smokePassed: true, protocol: "compatible" }),
    stateProbe: async () => ({ smokePassed: true, detail: "private-owned-root" }),
    editorProbe: async () => ({ configured: true, smokePassed: true, shortcut: "Ctrl+G" }),
    terminalProbe: async () => ({ smokePassed: true, unicode: true, color: true }),
    capabilityProbes: {
      web: async () => ({ smokePassed: true }),
      browser: async () => ({ denied: true, detail: "not-connected" }),
      image: async () => ({ unknown: true, detail: "not-tested" })
    }
  });

  assert.equal(report.overall, "attention");
  assert.equal(report.checks.find((check) => check.id === "codex").state, "available");
  assert.equal(report.checks.find((check) => check.id === "codex-auth").state, "configured");
  assert.equal(report.checks.find((check) => check.id === "broker").state, "smoke_passed");
  assert.equal(report.checks.find((check) => check.id === "browser").state, "denied");
  assert.equal(report.checks.find((check) => check.id === "image").state, "unknown");
});

test("doctor never mutates an account and reports probe failures as unknown", async () => {
  let mutations = 0;
  const report = await runDoctor({
    commandProbe: async () => ({ available: true }),
    authProbe: async () => { throw new Error("credential store unavailable"); },
    brokerProbe: async () => ({ smokePassed: true }),
    stateProbe: async () => ({ smokePassed: true }),
    editorProbe: async () => ({ configured: false }),
    terminalProbe: async () => ({ smokePassed: true }),
    capabilityProbes: {
      browser: async (context) => {
        assert.equal(context.mutate, false);
        mutations += Number(context.mutate);
        return { configured: true };
      }
    }
  });

  assert.equal(mutations, 0);
  assert.equal(report.checks.find((check) => check.id === "codex-auth").state, "unknown");
  assert.match(report.checks.find((check) => check.id === "codex-auth").detail, /unavailable/);
});
