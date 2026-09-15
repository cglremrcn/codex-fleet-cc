import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTempDir } from "./helpers.mjs";
import { captureSource, hashWorkspaceFile, safeRelativeFile } from "../plugins/fleet/scripts/lib/source-fingerprint.mjs";
import { admissionContractDigest } from "../plugins/fleet/scripts/lib/execution-evidence.mjs";
import { createEvidenceLedger } from "../plugins/fleet/scripts/lib/evidence-ledger.mjs";
import { createControlPlane } from "../plugins/fleet/scripts/fleet-supervisor.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) {
  const temp = await fs.realpath(makeTempDir("fleet-source-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = path.join(temp, "workspace"), stateRoot = path.join(temp, "private");
  await fs.mkdir(workspace); await fs.mkdir(stateRoot);
  git(workspace, "init", "-b", "main");
  git(workspace, "config", "user.name", "Fleet fixture"); git(workspace, "config", "user.email", "fixture@example.com");
  git(workspace, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(workspace, "code.txt"), "source revision A\n");
  await fs.writeFile(path.join(workspace, ".gitignore"), "evidence/\n");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "initial fixture");
  await fs.mkdir(path.join(workspace, "evidence"));
  await fs.writeFile(path.join(workspace, "evidence/unit.txt"), "unit results\n");
  return { temp, workspace, stateRoot };
}
function lane(id, extra = {}) {
  const result = { id, role: "implementer", label: id, prompt: "private worker instructions", model: "gpt-5.6-sol", effort: "high",
    workspaceKey: KEY, authority: { sandbox: "read-only", network: "off", process: { start: true, stopOwned: true } },
    admissionId: `admission-${id}`, threadId: `thread-${id}`, turnId: `turn-${id}`, executionRevision: 0,
    status: "complete", outcome: "accomplished", workPerformed: ["Done"], verificationResults: [{ check: "unit", status: "passed", evidence: "evidence/unit.txt" }],
    admittedAt: new Date().toISOString(), ...extra };
  result.contractDigest = admissionContractDigest(result);
  return result;
}
async function readyLedger(t) {
  const data = await fixture(t); const lanes = [lane("worker")];
  const ledger = createEvidenceLedger({ workspacePath: data.workspace, workspaceKey: KEY, stateRoot: data.stateRoot, snapshot: async () => ({ lanes }) });
  const cp = await ledger.checkpoint({ laneId: "worker", requiredChecks: ["unit"] });
  lanes.push(lane("verifier", { role: "independent-verifier", ...cp.verifierBinding }));
  const attest = () => ledger.attest({ checkpointId: cp.checkpointId, verifierLaneId: "verifier", evidenceFiles: [{ check: "unit", path: "evidence/unit.txt" }] });
  return { ...data, ledger, lanes, cp, attest };
}

test("source binds tracked bytes, Git index and non-ignored untracked files; ignored artifacts are explicit", async t => {
  const { workspace } = await fixture(t); const baseline = await captureSource(workspace);
  assert.equal(baseline.ignoredFilesBound, false); assert.equal(baseline.files, 2);
  await fs.writeFile(path.join(workspace, "evidence/unit.txt"), "new evidence");
  assert.deepEqual(await captureSource(workspace), baseline);
  await fs.writeFile(path.join(workspace, "code.txt"), "revision B\n");
  const dirty = await captureSource(workspace); assert.notEqual(dirty.digest, baseline.digest);
  git(workspace, "add", "code.txt"); const staged = await captureSource(workspace);
  assert.notEqual(staged.indexDigest, dirty.indexDigest); assert.notEqual(staged.digest, dirty.digest);
  await fs.writeFile(path.join(workspace, "new.txt"), "untracked source");
  assert.notEqual((await captureSource(workspace)).digest, staged.digest);
  await fs.rm(path.join(workspace, "code.txt"));
  assert.equal((await captureSource(workspace)).files, 3, "tracked deletion remains in the source manifest");
});

test("source refuses non-Git roots, subdirectories, oversized files and unsupported index entries", async t => {
  const { temp, workspace } = await fixture(t);
  await assert.rejects(captureSource(temp), { code: "SOURCE_GIT_UNAVAILABLE" });
  await assert.rejects(captureSource(path.join(workspace, "evidence")), { code: "SOURCE_ROOT_MISMATCH" });
  await assert.rejects(captureSource(workspace, { maxFiles: 1 }), { code: "SOURCE_BUDGET_EXCEEDED" });
  await assert.rejects(captureSource(workspace, { maxFileBytes: 1 }), { code: "SOURCE_BUDGET_EXCEEDED" });
  git(workspace, "update-index", "--add", "--cacheinfo", `160000,${git(workspace, "rev-parse", "HEAD")},submodule`);
  await assert.rejects(captureSource(workspace), { code: "SOURCE_INDEX_UNSUPPORTED" });
});

test("source refuses path escapes, devices, symlinks and hardlinks", async t => {
  const { workspace } = await fixture(t);
  for (const name of ["../outside", "/etc/passwd", ".git/config", "evidence\\unit.txt", "C:stream", "a//b", "a\u001bb"]) assert.throws(() => safeRelativeFile(name));
  await fs.link(path.join(workspace, "code.txt"), path.join(workspace, "hardlink.txt"));
  await assert.rejects(hashWorkspaceFile(workspace, "hardlink.txt"), { code: "SOURCE_PATH_UNSAFE" });
  await fs.rm(path.join(workspace, "hardlink.txt"));
  try { await fs.symlink("code.txt", path.join(workspace, "alias.txt")); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.diagnostic("Symlink creation unavailable; hardlink/path cases still ran."); return; } throw error; }
  await assert.rejects(hashWorkspaceFile(workspace, "alias.txt"), { code: "SOURCE_PATH_UNSAFE" });
});

test("Git environment overrides cannot redirect the selected source", async t => {
  const { workspace, temp } = await fixture(t); const before = await captureSource(workspace);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(temp, "not-the-repository");
  try { assert.deepEqual(await captureSource(workspace), before); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});

test("checkpoint and receipt survive restart without storing prompts, and repeated capture is idempotent", async t => {
  const { workspace, stateRoot, ledger, cp, attest, lanes } = await readyLedger(t);
  assert.equal((await ledger.checkpoint({ laneId: "worker", requiredChecks: ["unit"] })).checkpointId, cp.checkpointId);
  const receipt = await attest();
  const current = await ledger.check({ receiptId: receipt.receiptId }); assert.equal(current.current, true);
  assert.equal(current.releaseAuthorized, false);
  const restarted = createEvidenceLedger({ workspacePath: workspace, workspaceKey: KEY, stateRoot, snapshot: async () => ({ lanes }) });
  assert.equal((await restarted.check({ receiptId: receipt.receiptId })).current, true);
  assert.deepEqual(await restarted.stats(), { checkpoints: 1, receipts: 1 });
  assert.doesNotMatch(await fs.readFile(path.join(stateRoot, "evidence-ledger.json"), "utf8"), /private worker instructions|"prompt"/u);
});

test("old verification cannot accept a changed source tree or evidence artifact", async t => {
  const { workspace, ledger, attest } = await readyLedger(t); const receipt = await attest();
  await fs.writeFile(path.join(workspace, "evidence/unit.txt"), "changed log");
  assert.equal((await ledger.check({ receiptId: receipt.receiptId })).reason, "evidence-file-changed");
  await fs.writeFile(path.join(workspace, "code.txt"), "new source");
  assert.equal((await ledger.check({ receiptId: receipt.receiptId })).reason, "source-changed");
  await assert.rejects(attest(), { code: "EVIDENCE_SOURCE_CHANGED" });
});

test("worker/turn/steering revision changes invalidate a receipt rather than carrying green forward", async t => {
  const { ledger, attest, lanes } = await readyLedger(t); const receipt = await attest();
  for (const [key, value] of [["turnId", "new-turn"], ["executionRevision", 1], ["admissionId", "other-admission"], ["archivedAt", new Date().toISOString()]]) {
    const previous = lanes[0][key]; lanes[0][key] = value;
    assert.equal((await ledger.check({ receiptId: receipt.receiptId })).current, false, key);
    lanes[0][key] = previous;
  }
});

test("skipped, absent, duplicate and failed required checks never become verified", async t => {
  const { lanes, attest } = await readyLedger(t);
  for (const reports of [[], [{ check: "unit", status: "skipped" }], [{ check: "unit", status: "failed" }], [{ check: "unit", status: "passed" }, { check: "unit", status: "passed" }]]) {
    lanes[1].verificationResults = reports;
    await assert.rejects(attest(), { code: "EVIDENCE_CHECKS_NOT_PASSED" });
  }
});

test("unbound, writable and legacy verifiers cannot supply a receipt", async t => {
  const { ledger, lanes, cp, attest } = await readyLedger(t);
  const original = lanes[1];
  lanes[1] = { ...original, verificationCheckpoint: "f".repeat(64) };
  await assert.rejects(attest(), { code: "EVIDENCE_VERIFIER_INVALID" });
  lanes[1] = { ...original, authority: { ...original.authority, sandbox: "workspace-write" } };
  await assert.rejects(attest(), { code: "VERIFIER_AUTHORITY_INVALID" });
  lanes[1] = original; delete lanes[0].contractDigest;
  await assert.rejects(ledger.checkpoint({ laneId: "worker", requiredChecks: ["unit"] }), { code: "EVIDENCE_PROVENANCE_MISSING" });
  await assert.rejects(ledger.validateVerifier({ ...original, ...cp.verifierBinding }, { lanes }), { code: "EVIDENCE_PROVENANCE_MISSING" });
});

test("pending and unknown mutable work blocks evidence even when archived", async t => {
  const { ledger, lanes } = await readyLedger(t);
  const other = lane("uncertain", { status: "outcome_unknown", archivedAt: new Date().toISOString(), authority: { sandbox: "workspace-write" } });
  lanes.push(other);
  await assert.rejects(ledger.checkpoint({ laneId: "worker", requiredChecks: ["unit"] }), { code: "SOURCE_BUSY" });
});

test("tampered evidence records are rejected instead of reinterpreted", async t => {
  const { ledger, stateRoot, attest } = await readyLedger(t); const receipt = await attest();
  const file = path.join(stateRoot, "evidence-ledger.json"); const value = JSON.parse(await fs.readFile(file, "utf8"));
  value.checkpoints[0].payload.requiredChecks = ["weaker-check"];
  await fs.writeFile(file, JSON.stringify(value));
  await assert.rejects(ledger.check({ receiptId: receipt.receiptId }), { code: "EVIDENCE_LEDGER_INVALID" });
});

function fakeRuntime() {
  const lanes = new Map(); let calls = 0;
  return { get calls() { return calls; }, async startLane(contract) {
    calls++; const record = lane(contract.id, { ...contract, status: "complete" }); lanes.set(record.id, record); return record;
  }, inspectLane: id => lanes.get(id) ?? null, async continueLane() { throw new Error("not expected"); },
  async resumeLane() { throw new Error("not expected"); }, async interruptLane() {}, async close() {} };
}

test("real supervisor connects source checkpoints, guarded verifier dispatch and persisted receipts without extra inference", async t => {
  const { workspace, temp } = await fixture(t); let runtime = fakeRuntime();
  const options = { dataDir: path.join(temp, "fleet-state"), workspacePath: workspace, workspaceKey: KEY, token: "a".repeat(64), createRuntime: async () => runtime };
  let control = createControlPlane(options); t.after(() => control.close());
  const base = (id, role = "implementer", extra = {}) => ({ schemaVersion: 1, workspacePath: workspace, limits: { staggerMs: 0 }, lanes: [{ id, role, label: id,
    model: "gpt-5.6-sol", effort: "high", prompt: "Bounded fixture work.", authority: { sandbox: "read-only", network: "off", process: { start: true, stopOwned: true } }, ...extra }] });
  const request = (operation, params) => control.handle("control", { schemaVersion: 1, requestId: `test-${operation}`, workspacePath: workspace, operation, params });
  await control.handle("start", base("worker"));
  const cp = await request("checkpoint", { laneId: "worker", requiredChecks: ["unit"] }); assert.equal(cp.ok, true, JSON.stringify(cp));
  await control.handle("start", base("verifier", "independent-verifier", cp.data.verifierBinding));
  const result = await request("attest", { checkpointId: cp.data.checkpointId, verifierLaneId: "verifier", evidenceFiles: [{ check: "unit", path: "evidence/unit.txt" }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await request("check", { receiptId: result.data.receiptId })).data.current, true);
  assert.equal(runtime.calls, 2);
  const details = await request("result", { laneId: "worker" });
  assert.equal(details.data.sourceEvidence[0].receiptId, result.data.receiptId);
  assert.equal(details.data.sourceEvidence[0].currentSourceChecked, false);
  await control.close(); runtime = fakeRuntime(); control = createControlPlane(options);
  assert.equal((await request("check", { receiptId: result.data.receiptId })).data.current, true);
  assert.equal(runtime.calls, 0, "checking a persisted receipt must not start Codex");
  await fs.writeFile(path.join(workspace, "code.txt"), "changed after restart");
  await assert.rejects(control.handle("start", base("stale-verifier", "independent-verifier", cp.data.verifierBinding)), { code: "VERIFIER_SOURCE_CHANGED" });
  assert.equal(runtime.calls, 0);
});


test("receipt cannot silently attach an unrelated artifact to a reported verifier check", async t => {
  const { ledger, cp, attest, lanes } = await readyLedger(t);
  lanes[1].verificationResults[0].evidence = "different.txt";
  await assert.rejects(attest(), { code: "EVIDENCE_REFERENCE_MISMATCH" });
  assert.equal((await ledger.stats()).receipts, 0);
  assert.equal(cp.verifierBinding.verificationPlan.completion[0], "unit");
});
