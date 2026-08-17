import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeAction,
  normalizeAuthority,
  requiresConfirmation
} from "../plugins/fleet/scripts/lib/authority.mjs";

test("authority defaults fail closed without removing safe workspace reads", () => {
  const authority = normalizeAuthority({});

  assert.equal(authorizeAction(authority, "filesystem.read", {}).allowed, true);
  assert.equal(authorizeAction(authority, "filesystem.write", {}).allowed, false);
  assert.equal(authorizeAction(authority, "network.live", {}).allowed, false);
  assert.equal(authorizeAction(authority, "browser.inspect", {}).allowed, false);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.browser), true);
});

test("read-only investigator cannot edit or deploy", () => {
  const authority = normalizeAuthority({
    role: "investigator",
    sandbox: "read-only",
    network: "off"
  });

  assert.equal(authorizeAction(authority, "filesystem.write", {}).allowed, false);
  assert.equal(authorizeAction(authority, "deploy.production", {}).allowed, false);
});

test("role names never grant authority", () => {
  const authority = normalizeAuthority({ role: "implementer" });

  assert.equal(authorizeAction(authority, "filesystem.write", {}).allowed, false);
  assert.equal(authorizeAction(authority, "process.start", {}).allowed, false);
});

test("browser discovery is not browser account mutation authority", () => {
  const authority = normalizeAuthority({ browser: { inspect: true, mutate: false } });

  assert.equal(authorizeAction(authority, "browser.inspect", {}).allowed, true);
  assert.equal(authorizeAction(authority, "browser.submit", {}).allowed, false);
});

test("allowed external mutations still require explicit confirmation", () => {
  const authority = normalizeAuthority({
    browser: { inspect: true, mutate: true },
    externalEffects: { send: true, deploy: true }
  });

  assert.deepEqual(authorizeAction(authority, "browser.submit", {}), {
    allowed: true,
    reason: "browser-mutation-authorized",
    confirmationRequired: true
  });
  assert.equal(authorizeAction(authority, "send.message", {}).confirmationRequired, true);
  assert.equal(authorizeAction(authority, "deploy.production", {}).confirmationRequired, true);
});

test("owned process cancellation cannot target an unrelated process", () => {
  const authority = normalizeAuthority({ process: { start: true, stopOwned: true } });

  assert.equal(authorizeAction(authority, "process.stop", { owned: false }).allowed, false);
  assert.deepEqual(authorizeAction(authority, "process.stop", { owned: true }), {
    allowed: true,
    reason: "owned-process-stop-authorized",
    confirmationRequired: true
  });
});

test("unknown outcomes deny retry until reconciliation", () => {
  const authority = normalizeAuthority({ retry: true });

  assert.equal(
    authorizeAction(authority, "retry.operation", {
      outcome: "unknown",
      reconciled: false
    }).allowed,
    false
  );
  assert.deepEqual(
    authorizeAction(authority, "retry.operation", {
      outcome: "unknown",
      reconciled: true
    }),
    {
      allowed: true,
      reason: "retry-authorized-after-reconciliation",
      confirmationRequired: true
    }
  );
});

test("unknown actions deny instead of inheriting a nearby capability", () => {
  const authority = normalizeAuthority({
    sandbox: "workspace-write",
    network: "live",
    externalEffects: { send: true, payment: true, deploy: true, delete: true }
  });
  const decision = authorizeAction(authority, "shell.everything", {});

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "unknown-action");
  assert.equal(decision.confirmationRequired, false);
});

test("confirmation classification is explicit and stable", () => {
  for (const action of [
    "browser.submit",
    "process.stop",
    "database.write",
    "send.message",
    "payment.execute",
    "deploy.production",
    "delete.resource",
    "retry.operation",
    "authority.escalate"
  ]) {
    assert.equal(requiresConfirmation(action), true, action);
  }
  assert.equal(requiresConfirmation("filesystem.read"), false);
  assert.equal(requiresConfirmation("unknown.action"), false);
});

test("malformed authority values fail instead of coercing", () => {
  assert.throws(() => normalizeAuthority({ sandbox: "everything" }), /sandbox/i);
  assert.throws(() => normalizeAuthority({ network: true }), /network/i);
  assert.throws(() => normalizeAuthority({ browser: "yes" }), /browser/i);
  assert.throws(() => normalizeAuthority({ retry: "yes" }), /retry/i);
});
