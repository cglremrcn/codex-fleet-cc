import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createControlTransport, createFleetControlClient } from "../plugins/fleet/scripts/lib/control-client.mjs";
import { createMachineControl } from "../plugins/fleet/scripts/lib/control-service.mjs";
import { getFleetDataDir, workspaceKey } from "../plugins/fleet/scripts/lib/paths.mjs";
import { ensureSupervisor, stopSupervisor, readSupervisorManifest, requestSupervisor } from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { buildEnv, installFakeCodex } from "./upstream/fake-codex-fixture.mjs";

const scriptPath = path.resolve("plugins/fleet/scripts/fleet.mjs");
const supervisorScript = path.resolve("plugins/fleet/scripts/fleet-supervisor.mjs");
const KEY = "0123456789abcdef0123456789abcdef";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
async function fixture(t, behavior = "slow-task") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fleet-control-client-")));
  const workspacePath = path.join(root, "workspace"), bin = path.join(root, "bin"), home = path.join(root, "home");
  await Promise.all([workspacePath, bin, home].map(p => fs.mkdir(p)));
  git(workspacePath, "init", "-b", "main");
  git(workspacePath, "config", "user.name", "Fleet fixture"); git(workspacePath, "config", "user.email", "fixture@example.com");
  git(workspacePath, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(workspacePath, "source.txt"), "source");
  git(workspacePath, "add", "."); git(workspacePath, "commit", "-m", "fixture");
  installFakeCodex(bin, behavior);
  const env = { ...buildEnv(bin), HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, "state"), LOCALAPPDATA: path.join(home, "local"), CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"), FLEET_SUPERVISOR_IDLE_MS: "60000" };
  delete env.CLAUDE_PLUGIN_DATA; delete env.CLAUDE_PLUGIN_ROOT;
  const dataDir = getFleetDataDir(env, process.platform, home), key = await workspaceKey(workspacePath);
  const options = { workspacePath, workspaceKey: key, dataDir, scriptPath: supervisorScript, nodeExecutable: process.execPath, env };
  t.after(async () => { await stopSupervisor(options).catch(() => undefined); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const client = createFleetControlClient({ workspacePath, scriptPath, env });
  const state = async () => JSON.parse(await fs.readFile(path.join(bin, "fake-codex-state.json"), "utf8"));
  return { root, workspacePath, env, client, state, bin, options };
}
function contract(scope, id) {
  return { schemaVersion: 1, workspacePath: scope.workspacePath, lanes: [{ id, role: "investigator", label: `Inspect ${id}`, model: "gpt-5.6-sol", effort: "high", prompt: `Inspect the bounded fixture for ${id}.`, authority: { sandbox: "read-only", network: "off", process: { start: true, stopOwned: true } } }] };
}
async function complete(client, id) {
  let observation = await client.observe();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (observation.lanes.some(lane => lane.id === id && lane.status === "complete")) return client.call("result", { laneId: id });
    await client.wait(observation.cursor, { timeoutMs: 2000 }); observation = await client.observe(observation);
  }
  throw new Error("Fixture did not complete within bounded observation waits.");
}

test("Node client atomically assembles multiple pages and rejects mismatched response envelopes", async t => {
  const machine = createMachineControl({ workspacePath: process.cwd(), workspaceKey: KEY, snapshot: async () => ({ lanes: Array.from({ length: 100 }, (_, i) => ({ id: `lane-${i}`, status: "complete" })) }), callLegacy: async () => {} });
  t.after(() => machine.dispose());
  let calls = 0;
  const client = createFleetControlClient({ workspacePath: process.cwd(), transport: request => { calls++; return machine.handle(request); } });
  const first = await client.observe(undefined, { maxBytes: 2048 });
  assert.equal(first.lanes.length, 100); assert.ok(calls > 1);
  const before = calls; assert.deepEqual(await client.observe(first), first); assert.equal(calls, before + 1);
  const wrong = createFleetControlClient({ workspacePath: process.cwd(), transport: async request => ({ schemaVersion: 1, operation: request.operation, requestId: "other", ok: true, data: {} }) });
  await assert.rejects(wrong.call("observe"), { code: "CONTROL_CLIENT_RESPONSE_INVALID" });
});

test("local transport bounds clients and releases failed-start capacity", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fleet-cli-transport-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "fixture.mjs");
  await fs.writeFile(script, 'let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>setTimeout(()=>{const r=JSON.parse(text);console.log(JSON.stringify({...r,ok:true,data:{}}));},100));');
  const transport = createControlTransport({ scriptPath: script, maxConcurrent: 1 });
  const request = { schemaVersion: 1, requestId: "test", operation: "describe", params: {} };
  const pending = transport(request);
  await assert.rejects(transport(request), { code: "CONTROL_CLIENT_LIMIT" }); await pending;
  await transport(request);
  const missing = createControlTransport({ scriptPath: script, nodeExecutable: path.join(root, "missing"), maxConcurrent: 1 });
  for (let i = 0; i < 2; i++) await assert.rejects(missing(request), { code: "CONTROL_CLIENT_START_FAILED" });
});

test("actual CLI, authenticated supervisor IPC and JSONL broker support observation, start, wait and identity-pinned continuation", { timeout: 45000 }, async t => {
  const scope = await fixture(t);
  const described = await scope.client.call("describe"); assert.ok(described);
  assert.equal(await readSupervisorManifest(scope.options), null, "discovery must not create a supervisor");
  const empty = await scope.client.observe(); assert.equal(empty.lanes.length, 0);
  await assert.rejects(fs.access(path.join(scope.bin, "fake-codex-state.json")), { code: "ENOENT" });
  await scope.client.call("start", { contract: contract(scope, "worker") });
  const first = await complete(scope.client, "worker");
  assert.equal(first.status, "complete");
  const next = createFleetControlClient({ workspacePath: scope.workspacePath, scriptPath, env: scope.env });
  await next.call("continue", { laneId: "worker", message: "Continue the bounded fixture.", expectedThreadId: first.threadId, expectedTurnId: first.turnId, expectedExecutionRevision: first.executionRevision });
  const second = await complete(next, "worker");
  assert.equal(second.threadId, first.threadId); assert.notEqual(second.turnId, first.turnId);
  const state = await scope.state(); assert.equal(state.threads.length, 1);
  await assert.rejects(next.call("continue", { laneId: "worker", message: "Stale attempt must not start.", expectedThreadId: first.threadId, expectedTurnId: first.turnId, expectedExecutionRevision: first.executionRevision }), { code: "CONTROL_TARGET_CHANGED" });
});

test("actual prepared-plan replay never admits a second worker", { timeout: 45000 }, async t => {
  const scope = await fixture(t);
  const prepared = await scope.client.call("prepare", { contract: contract(scope, "planned"), graph: [{ id: "planned", estimatedTokens: 100, estimatedMs: 100 }], budget: { maxEstimatedTokens: 500, verificationReserveTokens: 100 } });
  assert.ok(prepared.planToken);
  await assert.rejects(fs.access(path.join(scope.bin, "fake-codex-state.json")), { code: "ENOENT" });
  const results = await Promise.all([scope.client.call("apply", { planToken: prepared.planToken }), scope.client.call("apply", { planToken: prepared.planToken })]);
  assert.deepEqual(results[0], results[1]);
  await complete(scope.client, "planned");
  assert.deepEqual(await scope.client.call("apply", { planToken: prepared.planToken }), results[0]);
  assert.equal((await scope.state()).threads.length, 1);
});

test("actual cancellation forwards every preview identity and force shutdown drains control waits", { timeout: 45000 }, async t => {
  const scope = await fixture(t, "interruptible-slow-task");
  await scope.client.call("start", { contract: contract(scope, "cancel-me") });
  const preview = await scope.client.call("cancel.preview", { laneId: "cancel-me" });
  assert.ok(preview.confirmationToken);
  await scope.client.call("cancel.apply", { laneId: "cancel-me", confirmationToken: preview.confirmationToken, expectedThreadId: preview.expectedThreadId, expectedTurnId: preview.expectedTurnId });
  assert.equal((await scope.state()).lastInterrupt.turnId, preview.expectedTurnId);
  await scope.client.call("start", { contract: contract(scope, "waiting") });
  const observation = await scope.client.observe();
  const manifest = await ensureSupervisor(scope.options);
  const waiting = requestSupervisor({ address: manifest.address, token: manifest.token, workspaceKey: scope.options.workspaceKey, method: "control", params: { schemaVersion: 1, requestId: "shutdown-wait", operation: "wait", workspacePath: scope.workspacePath, params: { cursor: observation.cursor, timeoutMs: 3600000 } } });
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = Date.now(); await stopSupervisor(scope.options);
  const ended = await waiting;
  assert.equal(ended.ok, false); assert.equal(ended.error.code, "CONTROL_CLOSED");
  assert.ok(Date.now() - started < 12000, "shutdown must not wait for the observation deadline");
});

test("client assembles paged text and JSON result sections outside model context", async t => {
  const result = { id: "big", status: "complete", workPerformed: ["界\n".repeat(5000), "last"], verificationResults: [{ check: "unit", status: "passed" }] };
  const machine = createMachineControl({ workspacePath: process.cwd(), workspaceKey: KEY, snapshot: async () => ({ lanes: [] }), callLegacy: async () => result });
  t.after(() => machine.dispose());
  const client = createFleetControlClient({ workspacePath: process.cwd(), transport: request => machine.handle(request) });
  assert.deepEqual((await client.readSection("big", "work", { maxBytes: 2048 })).items, result.workPerformed);
  assert.deepEqual((await client.readSection("big", "checks")).items, result.verificationResults);
});
