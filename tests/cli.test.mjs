import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  buildEnv,
  installFakeCodex
} from "./upstream/fake-codex-fixture.mjs";
import { runCli } from "../plugins/fleet/scripts/lib/cli.mjs";
import { workspaceKey } from "../plugins/fleet/scripts/lib/paths.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FLEET = path.join(ROOT, "plugins", "fleet", "scripts", "fleet.mjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fleet-cli-"));
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "untouched\n", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, data };
}

function runFleet(args, options = {}) {
  const result = spawnSync(process.execPath, [FLEET, ...args], {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    windowsHide: true
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function fixtureEnv(scope, overrides = {}) {
  return {
    ...process.env,
    LOCALAPPDATA: scope.data,
    HOME: scope.root,
    USERPROFILE: scope.root,
    ...overrides
  };
}

function workspaceSnapshot(workspace) {
  return fs.readdirSync(workspace, { recursive: true })
    .map(String)
    .sort()
    .map((name) => [name, fs.statSync(path.join(workspace, name)).isFile()
      ? fs.readFileSync(path.join(workspace, name), "utf8")
      : null]);
}

async function waitForCliLane(scope, laneId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runFleet(
      ["status", "--workspace", scope.workspace, "--json"],
      { cwd: scope.workspace, env: scope.env }
    );
    const lane = JSON.parse(result.stdout).lanes.find((candidate) => candidate.id === laneId);
    if (lane?.status === status) return lane;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for " + laneId + " to reach " + status + ".");
}

async function waitForCliSupervisorExit(scope, timeoutMs = 20_000) {
  const key = await workspaceKey(scope.workspace);
  const manifestPath = path.join(
    scope.data,
    "codex-fleet-cc",
    "supervisors",
    key,
    "supervisor.json"
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(manifestPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the CLI supervisor to exit.");
}

test("status is read-only and emits one machine JSON object", (t) => {
  const scope = fixture(t);
  const before = workspaceSnapshot(scope.workspace);
  const run = runFleet(
    ["status", "--json", "--workspace", scope.workspace],
    { cwd: scope.workspace, env: fixtureEnv(scope) }
  );

  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).schemaVersion, 1);
  assert.equal(run.stdout.trim().split(/\r?\n/).length, 1);
  assert.deepEqual(workspaceSnapshot(scope.workspace), before);
});

test("start rejects inline shell-bearing task input without executing it", (t) => {
  const scope = fixture(t);
  const marker = path.join(scope.workspace, "pwned");
  const run = runFleet(
    ["start", `$(touch ${marker})`],
    { cwd: scope.workspace, env: fixtureEnv(scope) }
  );

  assert.equal(run.code, 2);
  assert.match(run.stderr, /contract file or stdin/i);
  assert.equal(fs.existsSync(marker), false);
});

test("duplicate flags and unknown commands fail with invalid-input exit code", (t) => {
  const scope = fixture(t);
  const duplicate = runFleet(
    ["status", "--json", "--json", "--workspace", scope.workspace],
    { env: fixtureEnv(scope) }
  );
  const unknown = runFleet(["launch-everything"], { env: fixtureEnv(scope) });
  const misplaced = runFleet(
    ["status", "--output", "report.json", "--workspace", scope.workspace],
    { env: fixtureEnv(scope) }
  );

  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /duplicate flag/i);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/i);
  assert.equal(misplaced.code, 2);
  assert.match(misplaced.stderr, /not valid for status/i);
});

test("contract input rejects unknown properties and malformed UTF-8", (t) => {
  const scope = fixture(t);
  const unknownPath = path.join(scope.root, "unknown.json");
  const invalidPath = path.join(scope.root, "invalid.json");
  fs.writeFileSync(unknownPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    lanes: [],
    shellCommand: "rm -rf"
  }));
  fs.writeFileSync(invalidPath, Buffer.from([0xc3, 0x28]));

  const unknown = runFleet(
    ["start", "--contract", unknownPath],
    { env: fixtureEnv(scope) }
  );
  const invalid = runFleet(
    ["start", "--contract", invalidPath],
    { env: fixtureEnv(scope) }
  );

  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown contract property/i);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /utf-8/i);
});

test("contract input is bounded to 128 KiB", (t) => {
  const scope = fixture(t);
  const largePath = path.join(scope.root, "large.json");
  fs.writeFileSync(largePath, "x".repeat(128 * 1024 + 1), "utf8");
  const run = runFleet(
    ["start", "--contract", largePath],
    { env: fixtureEnv(scope) }
  );

  assert.equal(run.code, 2);
  assert.match(run.stderr, /128 kib/i);
});

test("doctor reports runtime unavailable with its dedicated exit code", (t) => {
  const scope = fixture(t);
  const run = runFleet(
    ["doctor", "--json", "--workspace", scope.workspace],
    { env: fixtureEnv(scope, { PATH: "" }) }
  );

  assert.equal(run.code, 4);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.overall, "blocked");
  assert.equal(payload.checks.find((check) => check.id === "codex").state, "unknown");
  assert.equal(payload.checks.find((check) => check.id === "browser").state, "unknown");
});

test("human doctor output explains a broker ownership refusal without guessing its owner", async (t) => {
  const scope = fixture(t);
  const stdout = [];
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
  const code = await runCli(["doctor", "--workspace", scope.workspace], {
    cwd: scope.workspace,
    env: fixtureEnv(scope, { PATH: "" }),
    home: scope.root,
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    dependencies: {
      createRuntime: async () => ({
        close: async () => { throw refusal; }
      })
    }
  });

  assert.equal(code, 4);
  assert.match(stdout.join(""), /PID 4242/iu);
  assert.match(stdout.join(""), /Fleet did not stop/iu);
  assert.doesNotMatch(stdout.join(""), /ChatGPT Desktop/iu);
});

test("export previews without writing and accepts only its exact confirmation token", (t) => {
  const scope = fixture(t);
  const output = path.join(scope.root, "support.json");
  const env = fixtureEnv(scope, { PATH: "" });
  const previewRun = runFleet(
    ["export", "--json", "--workspace", scope.workspace, "--output", output],
    { env }
  );

  assert.equal(previewRun.code, 0, previewRun.stderr);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.writesPerformed, false);
  assert.equal(fs.existsSync(output), false);

  const denied = runFleet(
    [
      "export", "--json", "--workspace", scope.workspace, "--output", output,
      "--confirm-token", "wrong-token"
    ],
    { env }
  );
  assert.equal(denied.code, 3);
  assert.equal(fs.existsSync(output), false);

  const written = runFleet(
    [
      "export", "--json", "--workspace", scope.workspace, "--output", output,
      "--confirm-token", preview.confirmationToken
    ],
    { env }
  );
  assert.equal(written.code, 0, written.stderr);
  assert.equal(JSON.parse(written.stdout).written, true);
  assert.equal(fs.existsSync(output), true);
});

test("authority-bearing commands require an explicit confirmation reference", (t) => {
  const scope = fixture(t);
  const contractPath = path.join(scope.root, "deploy.json");
  fs.writeFileSync(contractPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    lanes: [
      {
        id: "deploy-lane",
        role: "implementer",
        label: "Deploy release",
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "Deploy the verified release.",
        authority: {
          sandbox: "workspace-write",
          network: "live",
          process: { start: true, stopOwned: true },
          externalEffects: { deploy: true }
        }
      }
    ]
  }));

  const run = runFleet(
    ["start", "--contract", contractPath],
    { env: fixtureEnv(scope) }
  );

  assert.equal(run.code, 3);
  assert.match(run.stderr, /confirmation reference/i);
});

test("start reports every contract validation issue before contacting the supervisor", async (t) => {
  const scope = fixture(t);
  const stdout = [];
  const stderr = [];
  let supervisorRequests = 0;
  const code = await runCli(["start", "--stdin", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    readStdin: async () => Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspacePath: scope.workspace,
      confirmationRef: 42,
      lanes: [{
        id: "bad id",
        role: "wizard",
        label: "",
        model: "",
        effort: "",
        prompt: "Reject this malformed contract before admission.",
        priority: 0,
        authority: {
          sandbox: "read-only",
          network: "off",
          process: { start: true, stopOwned: true }
        }
      }]
    })),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    dependencies: {
      ensureSupervisor: async () => ({ address: "unused", token: "unused" }),
      requestSupervisor: async () => {
        supervisorRequests += 1;
        throw new Error("supervisor must not be contacted");
      }
    }
  });

  assert.equal(code, 2);
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /confirmationRef/iu);
  assert.match(stderr.join(""), /lanes\[0\]\.id/iu);
  assert.match(stderr.join(""), /lanes\[0\]\.role/iu);
  assert.match(stderr.join(""), /lanes\[0\]\.label/iu);
  assert.match(stderr.join(""), /lanes\[0\]\.model/iu);
  assert.match(stderr.join(""), /lanes\[0\]\.effort/iu);
  assert.match(stderr.join(""), /priority/iu);
  assert.equal(supervisorRequests, 0);
});

test("start rejects every duplicate lane id before partial admission", async (t) => {
  const scope = fixture(t);
  const stderr = [];
  let supervisorRequests = 0;
  const lane = {
    id: "duplicate-lane",
    role: "investigator",
    label: "Inspect a bounded surface",
    model: "gpt-5.6-sol",
    effort: "medium",
    prompt: "Inspect without changing files.",
    priority: "normal",
    authority: {
      sandbox: "read-only",
      network: "off",
      process: { start: true, stopOwned: true }
    }
  };
  const code = await runCli(["start", "--stdin", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    readStdin: async () => Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspacePath: scope.workspace,
      lanes: [lane, { ...lane }]
    })),
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    dependencies: {
      ensureSupervisor: async () => ({ address: "unused", token: "unused" }),
      requestSupervisor: async () => {
        supervisorRequests += 1;
        return { schemaVersion: 1, background: true, lanes: [] };
      }
    }
  });

  assert.equal(code, 2);
  assert.match(stderr.join(""), /lanes\[1\]\.id.*duplicate/isu);
  assert.equal(supervisorRequests, 0);
});

test("read-only start accepts a null confirmation reference", async (t) => {
  const scope = fixture(t);
  const stdout = [];
  const stderr = [];
  const code = await runCli(["start", "--stdin", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    readStdin: async () => Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspacePath: scope.workspace,
      confirmationRef: null,
      lanes: [{
        id: "nullable-ref",
        role: "investigator",
        label: "Accept a read-only contract",
        model: "gpt-5.6-sol",
        effort: "medium",
        prompt: "Inspect without external effects.",
        priority: "normal",
        authority: {
          sandbox: "read-only",
          network: "off",
          process: { start: true, stopOwned: true }
        }
      }]
    })),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    dependencies: {
      ensureSupervisor: async () => ({ address: "memory", token: "token" }),
      requestSupervisor: async () => ({
        schemaVersion: 1,
        background: true,
        lanes: [{ id: "nullable-ref", status: "running" }]
      })
    }
  });

  assert.equal(code, 0, stderr.join(""));
  assert.equal(JSON.parse(stdout.join("")).background, true);
});

test("database write authority requires confirmation before supervisor admission", async (t) => {
  const scope = fixture(t);
  const stderr = [];
  let supervisorRequests = 0;
  const code = await runCli(["start", "--stdin", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    readStdin: async () => Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspacePath: scope.workspace,
      lanes: [{
        id: "database-writer",
        role: "implementer",
        label: "Write one database record",
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "Write the approved database record.",
        priority: "high",
        authority: {
          sandbox: "read-only",
          network: "live",
          process: { start: true, stopOwned: true },
          database: { read: true, write: true }
        }
      }]
    })),
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    dependencies: {
      ensureSupervisor: async () => ({ address: "unused", token: "unused" }),
      requestSupervisor: async () => {
        supervisorRequests += 1;
        return { schemaVersion: 1, background: true, lanes: [] };
      }
    }
  });

  assert.equal(code, 3);
  assert.match(stderr.join(""), /database\.write/iu);
  assert.equal(supervisorRequests, 0);
});

test("image generation authority requires confirmation before supervisor admission", async (t) => {
  const scope = fixture(t);
  const stderr = [];
  let supervisorRequests = 0;
  const code = await runCli(["start", "--stdin", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    readStdin: async () => Buffer.from(JSON.stringify({
      schemaVersion: 1,
      workspacePath: scope.workspace,
      lanes: [{
        id: "image-generator",
        role: "visual-analyst",
        label: "Generate a project visual",
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "Use $imagegen and save the approved visual in the workspace.",
        priority: "normal",
        authority: {
          sandbox: "workspace-write",
          network: "off",
          process: { start: true, stopOwned: true },
          image: { generate: true, edit: false }
        }
      }]
    })),
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    dependencies: {
      ensureSupervisor: async () => ({ address: "unused", token: "unused" }),
      requestSupervisor: async () => {
        supervisorRequests += 1;
        return { schemaVersion: 1, background: true, lanes: [] };
      }
    }
  });

  assert.equal(code, 3);
  assert.match(stderr.join(""), /image\.generate/iu);
  assert.equal(supervisorRequests, 0);
});

test("start and follow-up use one background Fleet supervisor contract", async (t) => {
  const scope = fixture(t);
  const binDir = path.join(scope.root, "bin");
  fs.mkdirSync(binDir);
  installFakeCodex(binDir, "slow-task");
  const env = fixtureEnv(scope, { PATH: buildEnv(binDir).PATH });
  const cliScope = { ...scope, env };
  const contractPath = path.join(scope.root, "fleet.json");
  fs.writeFileSync(contractPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    lanes: [
      {
        id: "cli-investigator",
        role: "investigator",
        label: "Inspect the fixture",
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "Inspect the fixture without changing files.",
        authority: {
          sandbox: "read-only",
          network: "off",
          process: { start: true, stopOwned: true }
        }
      }
    ]
  }));

  const run = runFleet(
    ["start", "--contract", contractPath, "--json"],
    {
      cwd: scope.workspace,
      env
    }
  );

  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.background, true);
  assert.equal(payload.lanes[0].status, "running");
  const firstResult = runFleet(
    [
      "result", "--workspace", scope.workspace, "--lane", "cli-investigator",
      "--wait", "--timeout-ms", "5000", "--json"
    ],
    { cwd: scope.workspace, env }
  );
  const firstStatus = runFleet(
    ["status", "--workspace", scope.workspace, "--json"],
    { cwd: scope.workspace, env }
  );
  assert.equal(firstResult.code, 0, firstResult.stderr + firstStatus.stdout);
  const first = JSON.parse(firstResult.stdout).lanes[0];
  assert.equal(first.status, "complete");
  const fakeState = JSON.parse(
    fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")
  );
  assert.equal(fakeState.appServerStarts, 1);

  const followUpPath = path.join(scope.root, "follow-up.json");
  fs.writeFileSync(followUpPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    laneId: "cli-investigator",
    message: "Inspect the second CLI surface."
  }));
  const followUp = runFleet(
    ["follow-up", "--contract", followUpPath, "--json"],
    { cwd: scope.workspace, env }
  );
  assert.equal(followUp.code, 0, followUp.stderr);
  assert.equal(JSON.parse(followUp.stdout).status, "running");
  const secondResult = runFleet(
    [
      "result", "--workspace", scope.workspace, "--lane", "cli-investigator",
      "--wait", "--timeout-ms", "5000", "--json"
    ],
    { cwd: scope.workspace, env }
  );
  assert.equal(secondResult.code, 0, secondResult.stderr);
  const second = JSON.parse(secondResult.stdout).lanes[0];
  assert.equal(second.status, "complete");
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.turnId, first.turnId);
  await waitForCliSupervisorExit(cliScope);
});

test("cancel previews and confirms one exact CLI-owned turn", async (t) => {
  const scope = fixture(t);
  const binDir = path.join(scope.root, "bin");
  fs.mkdirSync(binDir);
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = fixtureEnv(scope, { PATH: buildEnv(binDir).PATH });
  const cliScope = { ...scope, env };
  const startPath = path.join(scope.root, "cancel-start.json");
  fs.writeFileSync(startPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    lanes: [{
      id: "cli-cancel",
      role: "investigator",
      label: "Cancel exact turn",
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "Wait for explicit cancellation.",
      authority: {
        sandbox: "read-only",
        network: "off",
        process: { start: true, stopOwned: true }
      }
    }]
  }));
  const started = runFleet(
    ["start", "--contract", startPath, "--json"],
    { cwd: scope.workspace, env }
  );
  assert.equal(started.code, 0, started.stderr);
  const running = await waitForCliLane(cliScope, "cli-cancel", "running");

  const previewPath = path.join(scope.root, "cancel-preview.json");
  fs.writeFileSync(previewPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    laneId: "cli-cancel"
  }));
  const previewRun = runFleet(
    ["cancel", "--contract", previewPath, "--json"],
    { cwd: scope.workspace, env }
  );
  assert.equal(previewRun.code, 0, previewRun.stderr);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.writesPerformed, false);
  assert.equal(preview.expectedTurnId, running.turnId);

  const confirmPath = path.join(scope.root, "cancel-confirm.json");
  fs.writeFileSync(confirmPath, JSON.stringify({
    schemaVersion: 1,
    workspacePath: scope.workspace,
    laneId: "cli-cancel",
    expectedThreadId: preview.expectedThreadId,
    expectedTurnId: preview.expectedTurnId,
    confirmationToken: preview.confirmationToken
  }));
  const confirmed = runFleet(
    ["cancel", "--contract", confirmPath, "--confirm", "--json"],
    { cwd: scope.workspace, env }
  );
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(JSON.parse(confirmed.stdout).accepted, true);
  await waitForCliLane(cliScope, "cli-cancel", "cancelled");
  await waitForCliSupervisorExit(cliScope);
});

test("setup previews before applying and uninstall requires its own exact token", (t) => {
  const scope = fixture(t);
  const claudeConfig = path.join(scope.root, ".claude-disposable");
  const pluginData = path.join(scope.root, "plugin-data");
  fs.mkdirSync(claudeConfig, { recursive: true });
  fs.writeFileSync(
    path.join(claudeConfig, "settings.json"),
    `${JSON.stringify({ env: { EDITOR: "code --wait" }, keep: true })}\n`
  );
  const env = fixtureEnv(scope, {
    CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_PLUGIN_DATA: pluginData
  });

  const previewRun = runFleet(["setup", "--json"], { env });
  assert.equal(previewRun.code, 0, previewRun.stderr);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.writesPerformed, false);
  assert.equal(fs.existsSync(path.join(pluginData, "ownership.json")), false);

  const appliedRun = runFleet(
    ["setup", "--json", "--confirm-token", preview.confirmationToken],
    { env }
  );
  assert.equal(appliedRun.code, 0, appliedRun.stderr);
  assert.equal(JSON.parse(appliedRun.stdout).applied, true);
  assert.equal(fs.existsSync(path.join(pluginData, "ownership.json")), true);

  const uninstallPreviewRun = runFleet(["uninstall", "--json"], { env });
  assert.equal(uninstallPreviewRun.code, 0, uninstallPreviewRun.stderr);
  const uninstallPreview = JSON.parse(uninstallPreviewRun.stdout);
  assert.equal(uninstallPreview.writesPerformed, false);

  const denied = runFleet(
    ["uninstall", "--json", "--confirm-token", "wrong-token"],
    { env }
  );
  assert.equal(denied.code, 3);

  const removed = runFleet(
    ["uninstall", "--json", "--confirm-token", uninstallPreview.confirmationToken],
    { env }
  );
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).restored, true);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeConfig, "settings.json"), "utf8"));
  assert.equal(settings.env.EDITOR, "code --wait");
  assert.equal(settings.keep, true);
});
