import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDisposableWorkspace,
  buildLiveSmokeContracts,
  cleanupDisposableRun,
  commandOutput,
  parseLiveSmokeArguments,
  sanitizeLiveEvidence
} from "../scripts/run-live-smoke.mjs";
import {
  ensureSupervisor,
  supervisorPaths
} from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { workspaceKey } from "../plugins/fleet/scripts/lib/paths.mjs";
import { makeTempDir } from "./helpers.mjs";

test("successful CLI diagnostics may report status on stderr", () => {
  assert.equal(
    commandOutput({ stdout: "", stderr: "Logged in using ChatGPT\n" }),
    "Logged in using ChatGPT"
  );
  assert.equal(
    commandOutput({ stdout: "codex-cli 0.147.0\n", stderr: "ignored" }),
    "codex-cli 0.147.0"
  );
});

test("app-server smoke exposes only the sandboxed exact-argv command probe", async () => {
  const source = await fs.readFile(
    path.resolve("scripts", "run-app-server-smoke.mjs"),
    "utf8"
  );

  assert.match(source, /--probe-command-exec/u);
  assert.match(source, /command\/exec/u);
  assert.match(source, /timeoutMs:\s*10_000/u);
  assert.doesNotMatch(source, /process\/spawn/u);
});

test("live smoke refuses to touch the real account without exact opt-in", () => {
  assert.throws(() => parseLiveSmokeArguments([]), /--confirm-live-account/u);
  assert.throws(
    () => parseLiveSmokeArguments(["--confirm-live-account", "--surprise"]),
    /unknown live smoke flag/iu
  );
  assert.deepEqual(parseLiveSmokeArguments(["--confirm-live-account"]), {
    confirmLiveAccount: true
  });
});

test("live smoke workspace must be a strict child of its disposable root", () => {
  const root = path.join(os.tmpdir(), "fleet-live-contract-root");
  assert.equal(
    assertDisposableWorkspace(path.join(root, "workspace"), root),
    path.resolve(root, "workspace")
  );
  assert.throws(() => assertDisposableWorkspace(root, root), /strict child/iu);
  assert.throws(
    () => assertDisposableWorkspace(path.join(root, "..", "outside"), root),
    /strict child/iu
  );
});

test("live smoke uses ephemeral read-only lanes with an independent verifier", () => {
  const workspacePath = path.resolve(os.tmpdir(), "fleet-live-contract", "workspace");
  const contracts = buildLiveSmokeContracts(workspacePath);

  assert.deepEqual(
    contracts.map((contract) => contract.lanes[0].role),
    ["investigator", "independent-verifier", "investigator"]
  );
  assert.equal(new Set(contracts.map((contract) => contract.lanes[0].id)).size, 3);
  for (const contract of contracts) {
    const lane = contract.lanes[0];
    assert.equal(lane.ephemeral, true);
    assert.equal(lane.authority.sandbox, "read-only");
    assert.equal(lane.authority.network, "off");
    assert.deepEqual(lane.authority.externalEffects, {
      send: false,
      payment: false,
      deploy: false,
      delete: false
    });
  }
  assert.match(contracts[0].lanes[0].prompt, /investigator-nonce\.txt/iu);
  assert.match(contracts[1].lanes[0].prompt, /follow-up-nonce\.txt/iu);
  assert.equal(contracts[0].lanes[0].effort, "high");
  assert.equal(contracts[1].lanes[0].effort, "medium");
});

test("published live evidence cannot retain prompts, messages, credentials, or runtime ids", () => {
  const secret = "never-retain-this-value";
  const secondSecret = "never-retain-this-second-value";
  const evidence = sanitizeLiveEvidence({
    codexVersion: "codex-cli 0.147.0",
    loginStatus: `Logged in ${secret}`,
    investigator: {
      id: "live-investigator",
      model: "gpt-5.6-sol",
      effort: "high",
      status: "complete",
      threadId: `thread-${secret}`,
      turnId: `turn-${secret}`,
      lastMessage: `LIVE_INVESTIGATOR_OK ${secret}`,
      prompt: secret
    },
    followUp: {
      status: "complete",
      threadId: `thread-${secret}`,
      turnId: `turn-2-${secret}`,
      lastMessage: `LIVE_FOLLOW_UP_OK ${secondSecret}`
    },
    verifier: {
      id: "live-verifier",
      model: "gpt-5.6-sol",
      effort: "high",
      status: "complete",
      threadId: `verifier-${secret}`,
      turnId: `verifier-turn-${secret}`,
      lastMessage: `LIVE_VERIFIER_OK ${secret} ${secondSecret}`
    },
    cancellation: { accepted: true, status: "cancelled", confirmationToken: secret },
    expectedNonces: { investigator: secret, followUp: secondSecret }
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(serialized.includes(secret), false);
  assert.equal(evidence.loginAuthenticated, true);
  assert.equal(evidence.investigator.nonceObserved, true);
  assert.equal(evidence.followUp.threadReused, true);
  assert.equal(evidence.followUp.turnChanged, true);
  assert.equal(evidence.followUp.nonceObserved, true);
  assert.equal(evidence.verifier.independentThread, true);
  assert.equal(evidence.verifier.bothNoncesObserved, true);
  assert.equal(evidence.passed, true);
});

test("live cleanup stops the exact owned supervisor before removing its workspace", async () => {
  const disposableRoot = makeTempDir("fleet-live-cleanup-");
  const workspacePath = path.join(disposableRoot, "workspace");
  const dataDir = path.join(disposableRoot, "state", "codex-fleet-cc");
  await fs.mkdir(workspacePath, { recursive: true });
  const key = await workspaceKey(workspacePath);
  const supervisorOptions = {
    dataDir,
    workspaceKey: key,
    workspacePath,
    scriptPath: path.resolve("plugins", "fleet", "scripts", "fleet-supervisor.mjs"),
    nodeExecutable: process.execPath,
    env: process.env
  };
  const manifest = await ensureSupervisor(supervisorOptions);
  const paths = supervisorPaths({ dataDir, workspaceKey: key });

  await cleanupDisposableRun({
    disposableRoot,
    workspacePath,
    dataDir,
    workspaceKey: key,
    manifest,
    supervisorOptions
  });

  await assert.rejects(fs.access(disposableRoot), /ENOENT/u);
  await assert.rejects(fs.access(paths.manifestPath), /ENOENT/u);
});
