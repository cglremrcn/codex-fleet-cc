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
import { SupervisorRequestTimeoutError } from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { validateStartContract } from "../plugins/fleet/scripts/lib/start-contract.mjs";

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

test("status flags validate limits, durations, contradictions, and repeatable statuses", async (t) => {
  const scope = fixture(t);
  const base = {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    stdout: () => undefined,
    stderr: () => undefined,
    dependencies: {
      readStateWithoutCreating: async () => ({ schemaVersion: 1, lanes: [], updatedAt: null }),
      probeExistingSupervisor: async () => ({ health: "not-running", protocol: "compatible" }),
      inspectBranch: () => "main"
    }
  };

  assert.equal(await runCli(["status", "--all", "--limit", "3"], base), 2);
  assert.equal(await runCli(["status", "--limit", "0"], base), 2);
  assert.equal(await runCli(["status", "--limit", "257"], base), 2);
  assert.equal(await runCli(["status", "--since", "0m"], base), 2);
  assert.equal(await runCli(["status", "--since", "366d"], base), 2);
  assert.equal(await runCli(["status", "--status", "imaginary"], base), 2);
  assert.equal(
    await runCli(["status", "--status", "running", "--status", "blocked"], base),
    0
  );
});

test("human status limits attention-first while JSON status is complete by default", async (t) => {
  const scope = fixture(t);
  const lanes = Array.from({ length: 57 }, (_, index) => ({
    id: `old-${index + 1}`,
    role: "investigator",
    status: "outcome_unknown",
    label: "Old uncertain work",
    finishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  lanes.push({
    id: "active-last-in-storage",
    role: "implementer",
    status: "running",
    label: "Must remain visible",
    startedAt: "2026-09-01T12:00:00.000Z"
  });
  const dependencies = {
    readStateWithoutCreating: async () => ({
      schemaVersion: 1,
      lanes,
      updatedAt: "2026-09-01T12:00:00.000Z"
    }),
    probeExistingSupervisor: async () => ({ health: "ready", protocol: "compatible" }),
    inspectBranch: () => "codex/reliability",
    now: () => Date.parse("2026-09-01T12:30:00.000Z")
  };
  const human = [];
  const humanCode = await runCli(["status"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    stdout: (text) => human.push(text),
    stderr: () => undefined,
    dependencies
  });
  const machine = [];
  const machineCode = await runCli(["status", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    stdout: (text) => machine.push(text),
    stderr: () => undefined,
    dependencies
  });

  assert.equal(humanCode, 5);
  assert.match(human.join(""), /Showing 32\/58 lanes/iu);
  assert.match(human.join(""), /active-last-in-storage/iu);
  assert.match(human.join(""), /outcome_unknown=26/iu);
  assert.equal(machineCode, 5);
  assert.equal(JSON.parse(machine.join("")).lanes.length, 58);
});

test("status observes the branch and existing supervisor without creating one", async (t) => {
  const scope = fixture(t);
  const stdout = [];
  let ensureCalls = 0;
  const code = await runCli(["status", "--json"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    dependencies: {
      readStateWithoutCreating: async () => ({ schemaVersion: 1, lanes: [], updatedAt: null }),
      inspectBranch: () => "detached",
      probeExistingSupervisor: async () => ({ health: "not-running", protocol: "compatible" }),
      ensureSupervisor: async () => {
        ensureCalls += 1;
        throw new Error("status must not create a supervisor");
      }
    }
  });

  assert.equal(code, 0);
  assert.equal(ensureCalls, 0);
  assert.equal(JSON.parse(stdout.join("")).workspace.branch, "detached");
  assert.equal(JSON.parse(stdout.join("")).runtime.health, "not-running");
});

test("result pretty and summary modes decode nested JSON messages", async (t) => {
  const scope = fixture(t);
  const lane = {
    id: "result-lane",
    role: "implementer",
    status: "complete",
    label: "Readable result",
    lastMessage: JSON.stringify({ summary: "Implemented safely", evidence: ["tests: pass"] })
  };
  const dependencies = {
    readStateWithoutCreating: async () => ({
      schemaVersion: 1,
      lanes: [lane],
      updatedAt: "2026-09-01T12:00:00.000Z"
    }),
    inspectBranch: () => "main"
  };
  const pretty = [];
  const summary = [];
  const common = {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    stderr: () => undefined,
    dependencies
  };

  assert.equal(await runCli(
    ["result", "--lane", "result-lane", "--pretty"],
    { ...common, stdout: (text) => pretty.push(text) }
  ), 0);
  assert.equal(typeof JSON.parse(pretty.join("")).lanes[0].lastMessage, "object");
  assert.equal(await runCli(
    ["result", "--lane", "result-lane", "--summary"],
    { ...common, stdout: (text) => summary.push(text) }
  ), 0);
  assert.match(summary.join(""), /Implemented safely/iu);
  assert.equal(summary.join("").includes('\\"summary\\"'), false);
  assert.equal(await runCli(
    ["result", "--lane", "result-lane", "--pretty", "--summary"],
    { ...common, stdout: () => undefined }
  ), 2);
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

test("init lists exact copy-paste contract templates without touching workspace state", (t) => {
  const scope = fixture(t);
  const before = workspaceSnapshot(scope.workspace);
  const run = runFleet(
    ["init", "--list", "--json"],
    { cwd: scope.workspace, env: fixtureEnv(scope) }
  );

  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(
    payload.templates.map((template) => template.name),
    ["research", "implementation", "verification", "image-generation"]
  );
  assert.equal(
    payload.templates.find((template) => template.name === "verification").role,
    "independent-verifier"
  );
  assert.equal(
    payload.templates.find((template) => template.name === "image-generation")
      .confirmationRequired,
    true
  );
  assert.deepEqual(workspaceSnapshot(scope.workspace), before);
});

test("init emits a start-valid research contract with one concrete objective", (t) => {
  const scope = fixture(t);
  const run = runFleet([
    "init",
    "--template", "research",
    "--workspace", scope.workspace,
    "--objective", "Summarize the workspace README with file evidence.",
    "--json"
  ], { cwd: scope.workspace, env: fixtureEnv(scope) });

  assert.equal(run.code, 0, run.stderr);
  const contract = JSON.parse(run.stdout);
  assert.equal(contract.workspacePath, path.resolve(scope.workspace));
  assert.equal(contract.confirmationRef, null);
  assert.equal(contract.lanes[0].role, "investigator");
  assert.equal(contract.lanes[0].priority, "normal");
  assert.match(contract.lanes[0].prompt, /Objective: Summarize the workspace README/i);
  assert.match(contract.lanes[0].prompt, /Stop conditions:/i);

  assert.doesNotThrow(() => validateStartContract(contract));
});

test("init requires explicit confirmation for writer and GPT Image 2 templates", (t) => {
  const scope = fixture(t);
  for (const template of ["implementation", "image-generation"]) {
    const denied = runFleet([
      "init",
      "--template", template,
      "--workspace", scope.workspace,
      "--objective", "Create the approved artifact.",
      "--json"
    ], { cwd: scope.workspace, env: fixtureEnv(scope) });
    assert.equal(denied.code, 3, denied.stderr);
    assert.match(denied.stderr, /confirmation-ref/i);
  }

  const image = runFleet([
    "init",
    "--template", "image-generation",
    "--workspace", scope.workspace,
    "--objective", "Create a square cyan-on-black product visual.",
    "--confirmation-ref", "user-approved-image-generation",
    "--json"
  ], { cwd: scope.workspace, env: fixtureEnv(scope) });

  assert.equal(image.code, 0, image.stderr);
  const contract = JSON.parse(image.stdout);
  assert.equal(contract.confirmationRef, "user-approved-image-generation");
  assert.equal(contract.lanes[0].role, "visual-analyst");
  assert.equal(contract.lanes[0].authority.image.generate, true);
  assert.match(contract.lanes[0].prompt, /\$imagegen/);
  assert.match(contract.lanes[0].prompt, /workspace-relative path/i);
  assert.match(contract.lanes[0].prompt, /parent Claude.*Read/iu);
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
        model: "gpt-5.6-slo",
        effort: "extreme",
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
  assert.match(stderr.join(""), /gpt-5\.6-sol/iu);
  assert.match(stderr.join(""), /low, medium, high/iu);
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

test("start reconciles exact, absent, and partial state after a post-send timeout", async (t) => {
  const scope = fixture(t);
  const key = await workspaceKey(scope.workspace);
  const raw = {
    schemaVersion: 1,
    workspacePath: scope.workspace,
    confirmationRef: null,
    lanes: ["one", "two"].map((suffix) => ({
      id: `timeout-${suffix}`,
      role: "investigator",
      label: `Inspect timeout ${suffix}`,
      model: "gpt-5.6-sol",
      effort: "medium",
      prompt: `Inspect bounded timeout surface ${suffix}.`,
      priority: "normal",
      authority: {
        sandbox: "read-only",
        network: "off",
        process: { start: true, stopOwned: true }
      }
    }))
  };
  const contract = validateStartContract(raw);
  const admittedAt = "2026-09-01T10:00:01.000Z";
  const persisted = contract.lanes.map((lane, index) => ({
    ...lane,
    checkoutKey: lane.checkoutKey ?? key,
    admissionId: `admission-${index + 1}`,
    admissionSource: "fleet-supervisor",
    admittedAt,
    status: "running",
    phase: "running"
  }));

  for (const [mode, lanes, expectedCode] of [
    ["exact", persisted, 0],
    ["absent", [], 5],
    ["partial", persisted.slice(0, 1), 5]
  ]) {
    const stdout = [];
    const stderr = [];
    const code = await runCli(["start", "--stdin", "--json"], {
      cwd: scope.workspace,
      env: fixtureEnv(scope),
      home: scope.root,
      readStdin: async () => Buffer.from(JSON.stringify(raw)),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      dependencies: {
        now: () => Date.parse("2026-09-01T10:00:00.000Z"),
        ensureSupervisor: async () => ({ address: "memory", token: "token" }),
        requestSupervisor: async () => {
          throw new SupervisorRequestTimeoutError({
            requestId: `request-${mode}`,
            requestSent: true,
            timeoutMs: 100
          });
        },
        readStateWithoutCreating: async () => ({
          schemaVersion: 1,
          lanes,
          updatedAt: admittedAt
        })
      }
    });
    const payload = JSON.parse(stdout.join(""));

    assert.equal(code, expectedCode, mode);
    assert.equal(stderr.join(""), "", mode);
    assert.equal(payload.retrySafe, false, mode);
    assert.equal(payload.admissionRecovered, mode === "exact", mode);
    assert.deepEqual(
      payload.admissionIds,
      mode === "exact" ? ["admission-1", "admission-2"] : [],
      mode
    );
  }
});

test("human timeout reconciliation warns against repeating start", async (t) => {
  const scope = fixture(t);
  const stdout = [];
  const raw = {
    schemaVersion: 1,
    workspacePath: scope.workspace,
    confirmationRef: null,
    lanes: [{
      id: "timeout-human",
      role: "investigator",
      label: "Inspect timeout recovery",
      model: "gpt-5.6-sol",
      effort: "medium",
      prompt: "Inspect the bounded timeout recovery surface.",
      priority: "normal",
      authority: {
        sandbox: "read-only",
        network: "off",
        process: { start: true, stopOwned: true }
      }
    }]
  };
  const code = await runCli(["start", "--stdin"], {
    cwd: scope.workspace,
    env: fixtureEnv(scope),
    home: scope.root,
    readStdin: async () => Buffer.from(JSON.stringify(raw)),
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    dependencies: {
      now: () => Date.parse("2026-09-01T10:00:00.000Z"),
      ensureSupervisor: async () => ({ address: "memory", token: "token" }),
      requestSupervisor: async () => {
        throw new SupervisorRequestTimeoutError({
          requestId: "request-human",
          requestSent: true,
          timeoutMs: 100
        });
      },
      readStateWithoutCreating: async () => ({ schemaVersion: 1, lanes: [], updatedAt: null })
    }
  });

  assert.equal(code, 5);
  assert.match(stdout.join(""), /run status/iu);
  assert.match(stdout.join(""), /do not repeat start/iu);
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
  assert.equal(preview.mode, "fresh");
  assert.equal(preview.previousVersion, null);
  assert.equal(fs.existsSync(path.join(pluginData, "ownership.json")), false);

  const appliedRun = runFleet(
    ["setup", "--json", "--confirm-token", preview.confirmationToken],
    { env }
  );
  assert.equal(appliedRun.code, 0, appliedRun.stderr);
  assert.equal(JSON.parse(appliedRun.stdout).applied, true);
  assert.equal(fs.existsSync(path.join(pluginData, "ownership.json")), true);

  const currentRun = runFleet(["setup", "--json"], { env });
  assert.equal(currentRun.code, 0, currentRun.stderr);
  const current = JSON.parse(currentRun.stdout);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, "plugins", "fleet", ".claude-plugin", "plugin.json"),
    "utf8"
  ));
  assert.equal(current.mode, "current");
  assert.equal(current.previousVersion, manifest.version);
  assert.deepEqual(current.changes, []);

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
