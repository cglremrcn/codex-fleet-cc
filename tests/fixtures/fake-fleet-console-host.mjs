import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { runConsole } from "../../plugins/fleet/scripts/lib/console-controller.mjs";
import { workspaceKey } from "../../plugins/fleet/scripts/lib/paths.mjs";
import {
  ensureSupervisor,
  requestSupervisor,
  stopSupervisor
} from "../../plugins/fleet/scripts/lib/supervisor-protocol.mjs";
import {
  buildEnv,
  installFakeCodex
} from "../upstream/fake-codex-fixture.mjs";

const recordPath = path.resolve(process.argv[2]);
const root = path.dirname(recordPath);
const workspacePath = path.join(root, "session-workspace");
const dataDir = path.join(root, "session-data");
const binDir = path.join(root, "session-bin");
const supervisorScript = path.resolve(
  "plugins",
  "fleet",
  "scripts",
  "fleet-supervisor.mjs"
);
await fsPromises.mkdir(workspacePath, { recursive: true });
await fsPromises.mkdir(dataDir, { recursive: true });
await fsPromises.mkdir(binDir, { recursive: true });
installFakeCodex(binDir, "slow-task");
const key = await workspaceKey(workspacePath);
const supervisorOptions = {
  dataDir,
  workspaceKey: key,
  workspacePath,
  scriptPath: supervisorScript,
  nodeExecutable: process.execPath,
  env: buildEnv(binDir)
};
const manifest = await ensureSupervisor(supervisorOptions);

function request(method, params = {}) {
  return requestSupervisor({
    address: manifest.address,
    workspaceKey: key,
    token: manifest.token,
    method,
    params
  });
}

await request("start", {
  schemaVersion: 1,
  workspacePath,
  lanes: [{
    id: "pty-session-lane",
    role: "investigator",
    label: "Exercise the real PTY Codex session",
    model: "gpt-5.6-sol",
    effort: "medium",
    prompt: "Inspect the bounded PTY fixture and return evidence.",
    authority: {
      sandbox: "read-only",
      network: "off",
      browser: { inspect: false, mutate: false },
      process: { start: true, stopOwned: true },
      database: { read: false, write: false },
      image: { generate: false, edit: false },
      externalEffects: { send: false, payment: false, deploy: false, delete: false },
      retry: false
    },
    priority: "normal"
  }]
});

let initialLane = null;
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const snapshot = await request("status");
  initialLane = snapshot.lanes.find((candidate) => candidate.id === "pty-session-lane");
  if (initialLane?.status === "complete") break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (initialLane?.status !== "complete") {
  throw new Error("PTY fixture lane did not reach complete.");
}

const runtime = {
  async session(selected) {
    return request("session", { laneId: selected.id });
  },
  async message(selected, message) {
    const accepted = await request("message", { laneId: selected.id, message });
    const record = {
      laneId: selected.id,
      threadId: accepted.threadId,
      originalThreadId: initialLane.threadId,
      message
    };
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    return accepted;
  }
};

try {
  await runConsole({
    cwd: workspacePath,
    runtime,
    readSnapshot: async () => request("status"),
    preferences: { color: false, unicode: true, reducedMotion: false, version: "test" }
  });
} finally {
  await stopSupervisor({ ...supervisorOptions, manifest }).catch(() => undefined);
}
