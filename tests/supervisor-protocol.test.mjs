import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MAX_SUPERVISOR_MESSAGE_BYTES,
  createSupervisorServer,
  ensureSupervisor,
  requestSupervisor,
  stopSupervisor,
  supervisorPaths
} from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import { makeTempDir } from "./helpers.mjs";

const WORKSPACE_KEY = "0123456789abcdef0123456789abcdef";
const TOKEN = "a".repeat(64);

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
    address: paths.address,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    method: "ping",
    params: {}
  });
  assert.deepEqual(accepted, { method: "ping", owner: "fleet" });

  await assert.rejects(requestSupervisor({
    address: paths.address,
    workspaceKey: WORKSPACE_KEY,
    token: "b".repeat(64),
    method: "ping",
    params: {}
  }), /authentication failed/i);
  await assert.rejects(requestSupervisor({
    address: paths.address,
    workspaceKey: "f".repeat(32),
    token: TOKEN,
    method: "ping",
    params: {}
  }), /workspace mismatch/i);
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
    address: paths.address,
    workspaceKey: WORKSPACE_KEY,
    token: TOKEN,
    method: "followUp",
    params: { message: "x".repeat(MAX_SUPERVISOR_MESSAGE_BYTES) }
  }), /exceeds/i);
  assert.equal(calls, 0);
});

test("supervisor paths stay private and deterministic per workspace", async (t) => {
  const dataDir = makeTempDir("fleet-supervisor-paths-");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });
  const second = supervisorPaths({ dataDir, workspaceKey: WORKSPACE_KEY });

  assert.deepEqual(first, second);
  assert.equal(path.dirname(first.manifestPath), first.root);
  assert.equal(path.dirname(first.lockPath), first.root);
  assert.match(first.address, process.platform === "win32" ? /^\\\\\.\\pipe\\/u : /\.sock$/u);
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
