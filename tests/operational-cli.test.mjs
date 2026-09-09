import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOperationalCli } from "../plugins/fleet/scripts/lib/operational-cli.mjs";
import { resolveFleetCli } from "../plugins/fleet/scripts/lib/fleet-entrypoint.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-operations-"));
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    workspace,
    data,
    env: {
      ...process.env,
      LOCALAPPDATA: data,
      HOME: root,
      USERPROFILE: root
    }
  };
}

function io(scope, dependencies = {}) {
  const stdout = [];
  const stderr = [];
  return {
    cwd: scope.workspace,
    env: scope.env,
    home: scope.root,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    dependencies,
    stdout,
    stderr
  };
}

function liveDeps(handler) {
  return {
    ensureSupervisor: async () => ({
      address: "test",
      workspaceKey: "unused",
      token: "a".repeat(64)
    }),
    requestSupervisor: handler
  };
}

test("operational help exposes the recovery surface and concrete follow-up schema", async (t) => {
  const scope = fixture(t);
  const first = io(scope);
  const second = io(scope);

  assert.equal(await runOperationalCli(["--help"], first), 0);
  assert.match(first.stdout.join(""), /watch.*reconcile.*resolve.*archive/is);
  assert.match(first.stdout.join(""), /cancel <id>/i);

  assert.equal(await runOperationalCli(["follow-up", "--help"], second), 0);
  assert.match(second.stdout.join(""), /"workspacePath".*"laneId".*"message"/s);
});

test("result wait defaults to ten minutes, uses one supervisor waiter, and timeout is not failure", async (t) => {
  const scope = fixture(t);
  const calls = [];
  const options = io(scope, liveDeps(async (request) => {
    calls.push(request);
    return {
      schemaVersion: 1,
      timedOut: true,
      elapsedMs: 600_000,
      lane: { id: "slow-lane", status: "running", phase: "running" }
    };
  }));

  const code = await runOperationalCli(
    ["result", "--lane", "slow-lane", "--wait", "--summary"],
    options
  );

  assert.equal(code, 0, options.stderr.join(""));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "waitForLane");
  assert.equal(calls[0].params.timeoutMs, 600_000);
  assert.match(options.stdout.join(""), /still running.*did not fail/is);
});

test("watch long-polls for meaningful transitions and preserves queue-stall detail", async (t) => {
  const scope = fixture(t);
  const calls = [];
  const options = io(scope, liveDeps(async (request) => {
    calls.push(request);
    return {
      schemaVersion: 1,
      changed: true,
      elapsedMs: 120_000,
      event: {
        kind: "queue-stalled",
        laneId: "queued-lane",
        status: "queued",
        queuedForMs: 1_200_000,
        queueBlocker: { kind: "writer-reservation" }
      }
    };
  }));

  assert.equal(await runOperationalCli([
    "watch",
    "--timeout-ms", "300000",
    "--stall-ms", "120000",
    "--json"
  ], options), 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "watchForEvent");
  assert.equal(calls[0].params.timeoutMs, 300_000);
  assert.equal(calls[0].params.stallMs, 120_000);
  assert.equal(JSON.parse(options.stdout.join("")).event.kind, "queue-stalled");
});

test("cancel lane shortcut performs identity-bound preview and confirmation and returns touched files", async (t) => {
  const scope = fixture(t);
  const calls = [];
  const options = io(scope, liveDeps(async (request) => {
    calls.push(request);
    if (calls.length === 1) {
      return {
        schemaVersion: 1,
        writesPerformed: false,
        laneId: "writer",
        expectedThreadId: "thread-1",
        expectedTurnId: "turn-1",
        touchedFiles: ["src/a.ts"],
        confirmationToken: "b".repeat(64)
      };
    }
    return {
      schemaVersion: 1,
      accepted: true,
      laneId: "writer",
      touchedFiles: ["src/a.ts"]
    };
  }));

  assert.equal(
    await runOperationalCli(["cancel", "writer", "--json"], options),
    0,
    options.stderr.join("")
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "cancel");
  assert.deepEqual(calls[0].params, { laneId: "writer" });
  assert.equal(calls[1].params.shortcut, true);
  assert.equal(calls[1].params.confirmationToken, "b".repeat(64));
  assert.deepEqual(JSON.parse(options.stdout.join("")).touchedFiles, ["src/a.ts"]);
});

test("reconcile, resolve, archive, and model refresh expose the supervisor operations added by P0", async (t) => {
  const scope = fixture(t);
  const methods = [];
  const dependencies = liveDeps(async (request) => {
    methods.push(request);
    if (request.method === "reconcileContinuation") {
      return {
        schemaVersion: 1,
        resolved: true,
        resolution: "not-started",
        lane: { id: "ambiguous", status: "complete" }
      };
    }
    if (request.method === "resolve") {
      return { id: "unknown", status: "complete", reconciliationRef: "git:abc" };
    }
    if (request.method === "archive") {
      return { id: "old", status: "complete", archivedAt: "2026-09-09T00:00:00.000Z" };
    }
    if (request.method === "models") {
      return {
        source: "connected-codex-runtime",
        discoveredAt: "2026-09-09T00:00:00.000Z",
        ageMs: 0,
        models: [{ model: "gpt-6-astra", efforts: ["high"] }]
      };
    }
    assert.fail(`Unexpected method ${request.method}`);
  });

  assert.equal(await runOperationalCli(
    ["reconcile", "ambiguous", "--assume-not-started", "--evidence", "codex:no-new-turn", "--json"],
    io(scope, dependencies)
  ), 0);
  assert.equal(await runOperationalCli(
    ["resolve", "unknown", "--evidence", "git:abc", "--outcome", "complete", "--json"],
    io(scope, dependencies)
  ), 0);
  assert.equal(await runOperationalCli(["archive", "old", "--json"], io(scope, dependencies)), 0);
  assert.equal(await runOperationalCli(["models", "--refresh", "--json"], io(scope, dependencies)), 0);

  assert.deepEqual(methods.map((call) => call.method), [
    "reconcileContinuation",
    "resolve",
    "archive",
    "models"
  ]);
  assert.equal(methods[0].params.assumeNotStarted, true);
  assert.equal(methods[0].params.evidenceRef, "codex:no-new-turn");
  assert.equal(methods[3].params.refresh, true);
});

test("status uses an existing live snapshot for queue blockers and hides archived lanes by default", async (t) => {
  const scope = fixture(t);
  const liveLanes = [
    {
      id: "queued",
      role: "implementer",
      label: "Waiting writer",
      status: "queued",
      enqueuedAt: "2026-09-09T08:00:00.000Z",
      queueBlocker: {
        kind: "writer-reservation",
        message: "Writer admission is blocked by an unresolved continuation reservation.",
        heldBy: [{ laneId: "stuck", kind: "continuation-reservation" }]
      }
    },
    {
      id: "old",
      role: "investigator",
      label: "Archived evidence",
      status: "complete",
      finishedAt: "2026-09-09T07:00:00.000Z",
      archivedAt: "2026-09-09T09:00:00.000Z"
    }
  ];
  const dependencies = {
    readStateWithoutCreating: async () => ({
      schemaVersion: 1,
      lanes: liveLanes,
      updatedAt: "2026-09-09T09:00:00.000Z"
    }),
    readSupervisorManifest: async () => ({
      address: "test",
      workspaceKey: "unused",
      token: "a".repeat(64)
    }),
    requestSupervisor: async ({ method }) => {
      assert.equal(method, "status");
      return { schemaVersion: 1, lanes: liveLanes };
    },
    probeExistingSupervisor: async () => ({ health: "ready", protocol: "compatible", active: 0 }),
    inspectBranch: () => "feature"
  };
  const human = io(scope, dependencies);
  const archived = io(scope, dependencies);

  assert.equal(await runOperationalCli(["status"], human), 0);
  assert.match(human.stdout.join(""), /QUEUE BLOCKED.*writer-reservation.*stuck/is);
  assert.match(human.stdout.join(""), /1 archived lane.*hidden/is);
  assert.equal(human.stdout.join("").includes("Archived evidence"), false);

  assert.equal(await runOperationalCli(["status", "--archived", "--json"], archived), 0);
  const payload = JSON.parse(archived.stdout.join(""));
  assert.deepEqual(payload.lanes.map((lane) => lane.id), ["old"]);
  assert.equal(payload.selection.archiveMode, "only");
});

test("empty status identifies registered sibling worktree ledgers instead of claiming the fleet is empty", async (t) => {
  const scope = fixture(t);
  const options = io(scope, {
    readStateWithoutCreating: async () => ({
      schemaVersion: 1,
      lanes: [],
      updatedAt: null
    }),
    readSupervisorManifest: async () => null,
    probeExistingSupervisor: async () => ({ health: "not-running", protocol: "compatible", active: 0 }),
    inspectBranch: () => "main",
    relatedWorktreeLedgers: async () => [{
      workspaceKey: "f".repeat(32),
      name: "feature-worktree",
      laneCount: 3,
      attentionCount: 1
    }]
  });

  assert.equal(await runOperationalCli(["status", "--json"], options), 0);
  const payload = JSON.parse(options.stdout.join(""));
  assert.equal(payload.lanes.length, 0);
  assert.equal(payload.workspaceRouting.relatedWorktrees[0].laneCount, 3);
  assert.match(payload.workspaceRouting.hint, /distinct Fleet ledger/i);
});

test("entrypoint routes runtime controls to the applied integration but keeps setup local", async (t) => {
  const scope = fixture(t);
  const runtime = path.join(scope.root, "integration", "runtime", "9.9.9");
  fs.mkdirSync(path.join(runtime, "lib"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "lib", "cli.mjs"), "export const placeholder = true;\n");
  const remoteRunner = async () => 17;
  let reads = 0;
  const common = {
    env: scope.env,
    home: scope.root,
    readAppliedRuntime: async () => {
      reads += 1;
      return { version: "9.9.9", runtimeTargetDir: runtime };
    },
    importer: async () => ({ runCli: remoteRunner })
  };

  const status = await resolveFleetCli(["status"], common);
  assert.equal(status.source, "owned-integration-runtime");
  assert.equal(status.runner, remoteRunner);
  assert.equal(reads, 1);

  const setup = await resolveFleetCli(["setup"], common);
  assert.equal(setup.source, "installed-plugin");
  assert.notEqual(setup.runner, remoteRunner);
  assert.equal(reads, 1);
});

test("operational mutators reject missing evidence and unknown outcomes stay fail-closed", async (t) => {
  const scope = fixture(t);
  const first = io(scope);
  const second = io(scope);

  assert.equal(await runOperationalCli(
    ["reconcile", "ambiguous", "--assume-not-started"],
    first
  ), 2);
  assert.match(first.stderr.join(""), /requires --evidence/i);

  assert.equal(await runOperationalCli(
    ["resolve", "unknown", "--outcome", "complete"],
    second
  ), 2);
  assert.match(second.stderr.join(""), /evidence reference/i);
});
