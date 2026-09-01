import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  createAppServerBroker,
  resolveExecutable
} from "../plugins/fleet/scripts/app-server-broker.mjs";
import { codexInvocation, commandOutput } from "./run-live-smoke.mjs";

const args = process.argv.slice(2);
const supportedArgs = new Set(["--probe-command-exec"]);
const unknownArgs = args.filter((arg) => !supportedArgs.has(arg));
if (unknownArgs.length > 0) {
  throw new Error(`Unknown argument: ${unknownArgs.join(", ")}`);
}

const probeCommandExec = args.includes("--probe-command-exec");

function detectCliVersion() {
  const executable = resolveExecutable("codex", { env: process.env });
  const invocation = codexInvocation(executable, ["--version"], { env: process.env });
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 65_536,
    shell: false,
    timeout: 2_000,
    windowsHide: true
  });
  const version = commandOutput(result).split(/\r?\n/u)[0];
  return version.slice(0, 128) || "unknown";
}

function boundedErrorClass(error) {
  const candidate = error?.code ?? error?.name ?? "Error";
  return String(candidate).replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64);
}

const events = [];
const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-app-server-smoke-"));
fs.writeFileSync(
  path.join(disposableRoot, "package.json"),
  `${JSON.stringify({ name: "fleet-disposable-probe", private: true })}\n`,
  "utf8"
);
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const broker = await createAppServerBroker({
  codexCommand: "codex",
  cwd: disposableRoot,
  env: process.env,
  onProtocolMessage(summary) {
    events.push(summary);
    if (events.length > 256) events.shift();
    if (summary.method === "turn/completed") resolveCompleted();
  }
});
const commandExec = {
  requested: probeCommandExec,
  platform: process.platform,
  cliVersion: detectCliVersion()
};

try {
  if (probeCommandExec) {
    try {
      const result = await broker.request("command/exec", {
        command: [
          process.execPath,
          "-e",
          "require('node:child_process').spawnSync(process.execPath,['--version'],{stdio:'inherit'})"
        ],
        cwd: disposableRoot,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [disposableRoot],
          networkAccess: false
        },
        timeoutMs: 10_000
      }, { timeoutMs: 15_000 });
      commandExec.exitCode = result?.exitCode ?? null;
    } catch (error) {
      commandExec.errorClass = boundedErrorClass(error);
    }
  }

  const skillCatalog = await broker.request("skills/list", {
    cwds: [disposableRoot],
    forceReload: true
  });
  const imageSkill = (Array.isArray(skillCatalog?.data) ? skillCatalog.data : [])
    .flatMap((group) => Array.isArray(group?.skills) ? group.skills : [])
    .find((skill) => skill?.name === "imagegen");
  const thread = await broker.request("thread/start", {
    cwd: disposableRoot,
    model: "gpt-5.6-sol",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: false
    },
    serviceName: "codex_fleet_cc_diagnostic",
    ephemeral: true
  });
  await broker.request("turn/start", {
    threadId: thread.thread.id,
    input: [{
      type: "text",
      text: "Read package.json and reply LIVE_APP_SERVER_OK plus the package name. Do not edit files."
    }],
    cwd: disposableRoot,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: false
    },
    model: "gpt-5.6-sol",
    effort: "high",
    outputSchema: null
  });
  const finished = await Promise.race([
    completed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 60_000))
  ]);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    finished,
    imagegen: {
      discovered: Boolean(imageSkill),
      enabled: imageSkill?.enabled === true,
      system: imageSkill?.scope === "system",
      safePath: typeof imageSkill?.path === "string"
        && path.isAbsolute(imageSkill.path)
        && path.basename(imageSkill.path).toLowerCase() === "skill.md"
    },
    commandExec,
    events
  })}\n`);
  if (!finished || (probeCommandExec && commandExec.exitCode !== 0)) process.exitCode = 1;
} finally {
  await broker.close();
  fs.rmSync(disposableRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
