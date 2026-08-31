import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MAX_SUPERVISOR_MESSAGE_BYTES,
  SupervisorRequestTimeoutError,
  createSupervisorServer,
  ensureSupervisor,
  probeExistingSupervisor,
  requestSupervisor,
  stopSupervisor,
  supervisorPaths
} from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { makeTempDir } from "./helpers.mjs";

const WORKSPACE_KEY = "0123456789abcdef0123456789abcdef";
const TOKEN = "a".repeat(64);

test("stopping a stale manifest never targets a reused process id", async () => {
  const outcome = await stopSupervisor({
    manifest: {
      process: { pid: 4242, recordedStart: "original-process" }
    },
    observeStart: async () => "reused-process"
  });

  assert.deepEqual(outcome, { stopped: true, reason: "owned-process-gone" });
});

test("authenticated local supervisor accepts only its workspace and token", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-auth-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const paths = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });
  const server = await createSupervisorServer({
    ...paths,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    handleRequest: async ({ method }) => ({ method, owner: "fleet" })
  });
  t.after(() => server.close());

  const accepted = await requestSupervisor({
    address: server.address,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    method: "ping",
    params: {}
  });
  assert.deepEqual(accepted, { method: "ping", owner: "fleet" });

  await assert.rejects(requestSupervisor({
    address: server.address,
    workspaceKey: WORKSPACE_KEY,
    token: "b".repeat(64),
    method: "ping",
    params: {}
  }), /authentication failed/i);
  await assert.rejects(requestSupervisor({
    address: server.address,
    workspaceKey: "f".repeat(32),
    token: TOKEN,
    method: "ping",
    params: {}
  }), /workspace mismatch/i);
});

test("post-send timeout exposes immutable request acceptance metadata", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-timeout-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const paths = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });
  let acceptedRequest = null;
  const server = await createSupervisorServer({
    ...paths,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    handleRequest: async (request) => {
      acceptedRequest = request;
      return new Promise(() => undefined);
    }
  });
  t.after(() => server.close());

  await assert.rejects(
    requestSupervisor({
      address: server.address,
      workspaceKey: WORKSPACE_KEY,
      token: TOKEN,
      method: "start",
      params: { lanes: [] },
      requestId: "request-timeout-1",
      timeoutMs: 100
    }),
    (error) => {
      assert.equal(error instanceof SupervisorRequestTimeoutError, true);
      assert.equal(error.code, "SUPERVISOR_RESPONSE_TIMEOUT");
      assert.equal(error.requestId, "request-timeout-1");
      assert.equal(error.requestSent, true);
      assert.equal(error.timeoutMs, 100);
      return true;
    }
  );
  assert.equal(acceptedRequest.requestId, "request-timeout-1");
});

test("supervisor protocol rejects oversized requests before dispatch", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-bounds-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const paths = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });
  let calls = 0;
  const server = await createSupervisorServer({
    ...paths,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    handleRequest: async () => {
      calls += 1;
      return {};
    }
  });
  t.after(() => server.close());

  await assert.rejects(requestSupervisor({
    address: server.address,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    method: "followUp",
    params: { message: "x".repeat(MAX_SUPERVISOR_MESSAGE_BYTES) }
  }), /exceeds/i);
  assert.equal(calls, 0);
});

test("supervisor envelope can carry a maximum-size CLI contract", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-envelope-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const paths = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });
  const sourceContract = { prompt: "x".repeat(128 * 1024 - 100) };
  assert.ok(Buffer.byteLength(JSON.stringify(sourceContract), "utf8") <= 128 * 1024);
  const server = await createSupervisorServer({
    ...paths,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    handleRequest: async ({ params }) => ({ length: params.sourceContract.prompt.length })
  });
  t.after(() => server.close());

  const accepted = await requestSupervisor({
    address: server.address,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    method: "start",
    params: { sourceContract }
  });
  assert.equal(accepted.length, sourceContract.prompt.length);
});

test("supervisor paths stay private and deterministic per workspace", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-paths-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });
  const second = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });

  assert.deepEqual(first, second);
  assert.equal(path.dirname(first.manifestPath), first.root);
  assert.equal(path.dirname(first.lockPath), first.root);
  if (process.platform === "win32") assert.match(first.address, /^\\\\\.\\pipe\\/u);
  else assert.equal(first.address, null);

  const longDataDir = path.join(dataDir, "x".repeat(160));
  const portable = supervisorPaths({
    dataDir: longDataDir,
    workspaceKey: WORKSPACE_KEY,
    platform: "darwin"
  });
  assert.equal(portable.address, null);
});

test("existing-supervisor probe never creates an absent runtime", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-probe-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const result = await probeExistingSupervisor({
    dataDir,
    workspaceKey: WORKSPACE_KEY,
    timeoutMs: 100
  });

  assert.deepEqual(result, { health: "not-running", protocol: "compatible", active: 0 });
  await assert.rejects(
    fs.readFile(supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY }).manifestPath, "utf8"),
    /ENOENT/u
  );
});

test("supervisor root rejects a symbolic-link ancestor", async (t) => {
  const parent = makeTempDir("fleet-supervisor-symlink-");
  const target = makeTempDir("fleet-supervisor-target-");
  const linkedDataDir = path.join(parent, "linked-data");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  try {
    await fs.symlink(target, linkedDataDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Symlink creation is unavailable in this environment.");
      return;
    }
    throw error;
  }

  const paths = supervisorPaths({ dataDir: linkedDataDir, workspaceKey: WORKSPACE_KEY });
  await assert.rejects(createSupervisorServer({
    ...paths,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    handleRequest: async () => ({})
  }), /symbolic link/i);
  await assert.rejects(fs.access(path.join(target, "supervisors")), /ENOENT/u);
});

test("concurrent clients start one owned supervisor process", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-process-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const scriptPath = path.resolve(
    "plugins",
    "fleet",
    "scripts",
    "fleet-supervisor.mjs"
  );
  const options = {
    dataDir,
    workspaceKey: WORKSPACE_KEY,
    workspacePath: dataDir,
    scriptPath,
    nodeExecutable: process.execPath,
    env: process.env
  };

  const [first, second] = await Promise.all([
    ensureSupervisor(options),
    ensureSupervisor(options)
  ]);
  t.after(() => stopSupervisor({ ...options, manifest: first }).catch(() => undefined));

  assert.equal(first.process.pid, second.process.pid);
  assert.equal(first.process.recordedStart, second.process.recordedStart);
  assert.deepEqual(await requestSupervisor({
    address: first.address,
    workspaceKey: WORKSPACE_KEY,
    token: first.token,
    method: "ping",
    params: {}
  }), { ready: true, active: 0 });

  const stopped = await stopSupervisor({ ...options, manifest: first });
  assert.equal(stopped.stopped, true);
  await assert.rejects(fs.readFile(first.manifestPath, "utf8"), /ENOENT/u);
});

test("POSIX supervisors use a private random socket directory", {
  skip: process.platform === "win32"
}, async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-posix-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const scriptPath = path.resolve("plugins", "fleet", "scripts", "fleet-supervisor.mjs");
  const options = {
    dataDir,
    workspaceKey: WORKSPACE_KEY,
    workspacePath: dataDir,
    scriptPath,
    nodeExecutable: process.execPath,
    env: process.env
  };

  const first = await ensureSupervisor(options);
  const directory = path.dirname(first.address);
  const directoryMetadata = await fs.lstat(directory);
  const socketMetadata = await fs.lstat(first.address);
  assert.equal(directoryMetadata.isDirectory(), true);
  assert.equal(directoryMetadata.isSymbolicLink(), false);
  assert.equal(directoryMetadata.mode & 0o077, 0);
  assert.equal(socketMetadata.isSocket(), true);
  assert.equal(socketMetadata.mode & 0o077, 0);

  await stopSupervisor({ ...options, manifest: first });
  const second = await ensureSupervisor(options);
  t.after(() => stopSupervisor({ ...options, manifest: second }).catch(() => undefined));
  assert.notEqual(second.address, first.address);
  assert.equal(Buffer.byteLength(second.address, "utf8") < 100, true);
});
