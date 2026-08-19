import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDisposableWorkspace,
  buildLiveSmokeContracts,
  parseLiveSmokeArguments,
  sanitizeLiveEvidence
} from "../scripts/run-live-smoke.mjs";

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
});

test("published live evidence cannot retain prompts, messages, credentials, or runtime ids", () => {
  const secret = "never-retain-this-value";
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
      lastMessage: secret,
      prompt: secret
    },
    followUp: {
      status: "complete",
      threadId: `thread-${secret}`,
      turnId: `turn-2-${secret}`,
      lastMessage: secret
    },
    verifier: {
      id: "live-verifier",
      model: "gpt-5.6-sol",
      effort: "high",
      status: "complete",
      threadId: `verifier-${secret}`,
      turnId: `verifier-turn-${secret}`
    },
    cancellation: { accepted: true, status: "cancelled", confirmationToken: secret }
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(serialized.includes(secret), false);
  assert.equal(evidence.loginAuthenticated, true);
  assert.equal(evidence.followUp.threadReused, true);
  assert.equal(evidence.followUp.turnChanged, true);
  assert.equal(evidence.verifier.independentThread, true);
});
