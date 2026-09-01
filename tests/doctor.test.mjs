import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  resolveDiagnosticInvocation,
  runDoctor
} from "../plugins/fleet/scripts/lib/doctor.mjs";

test("doctor resolves an earlier Windows Codex wrapper before a later executable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-doctor-wrapper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npmBin = path.join(root, "npm-bin");
  const desktopBin = path.join(root, "desktop-bin");
  fs.mkdirSync(npmBin);
  fs.mkdirSync(desktopBin);
  const wrapper = path.join(npmBin, "codex.cmd");
  fs.writeFileSync(wrapper, "@echo off\r\n");
  fs.writeFileSync(path.join(desktopBin, "codex.exe"), "old desktop binary");
  const commandProcessor = "C:\\Windows\\System32\\cmd.exe";

  assert.deepEqual(resolveDiagnosticInvocation("codex", ["--version"], {
    platform: "win32",
    env: {
      PATH: `${npmBin};${desktopBin}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: commandProcessor
    }
  }), {
    command: commandProcessor,
    args: ["/d", "/s", "/c", "call", wrapper, "--version"]
  });
});

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

test("doctor preserves safe structured broker ownership diagnostics", async () => {
  const refusal = new Error("Refused to stop an unverified app-server process.");
  refusal.code = "FLEET_BROKER_OWNERSHIP_REFUSED";
  refusal.diagnostic = {
    reasonCode: "ownership-mismatch",
    action: "not_stopped",
    pid: 4242,
    recordedIdentityPresent: true,
    currentIdentity: "different",
    remediation: "Re-run doctor; inspect the process through normal OS or app controls."
  };
  const report = await runDoctor({
    commandProbe: async () => ({ available: true }),
    authProbe: async () => ({ configured: true }),
    brokerProbe: async () => { throw refusal; },
    stateProbe: async () => ({ smokePassed: true }),
    editorProbe: async () => ({ configured: true }),
    terminalProbe: async () => ({ smokePassed: true })
  });

  const broker = report.checks.find((check) => check.id === "broker");
  assert.equal(broker.state, "unknown");
  assert.deepEqual(broker.diagnostic, refusal.diagnostic);
  assert.equal(report.overall, "blocked");
});

test("timed-out command probes release pipes even when close never arrives", async () => {
  const doctorModule = await import("../plugins/fleet/scripts/lib/doctor.mjs");
  assert.equal(typeof doctorModule.probeCommand, "function");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  let unrefs = 0;
  child.kill = () => {
    kills += 1;
    return true;
  };
  child.unref = () => {
    unrefs += 1;
  };

  const result = await doctorModule.probeCommand("hanging-probe", ["--version"], {
    timeoutMs: 5,
    killGraceMs: 5,
    spawnProcess: () => child
  });

  assert.equal(result.unknown, true);
  assert.match(result.detail, /timed out/iu);
  assert.equal(kills, 1);
  assert.equal(unrefs, 1);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});
