import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";
import { getFleetDataDir, workspaceKey } from "../plugins/fleet/scripts/lib/paths.mjs";
import {
  readSupervisorManifest,
  stopSupervisor
} from "../plugins/fleet/scripts/lib/supervisor-protocol.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FLEET = path.join(ROOT, "plugins", "fleet", "scripts", "fleet.mjs");
const LIVE_FLAG = "--confirm-live-account";
const MODEL = "gpt-5.6-sol";
const EFFORT = "high";
const COMMAND_TIMEOUT_MS = 240_000;
const RESULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export function parseLiveSmokeArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("Live smoke arguments must be an array.");
  for (const argument of argv) {
    if (argument !== LIVE_FLAG) throw new Error(`Unknown live smoke flag: ${argument}.`);
  }
  if (argv.length !== 1 || argv[0] !== LIVE_FLAG) {
    throw new Error(`Real Codex account access requires exactly ${LIVE_FLAG}.`);
  }
  return { confirmLiveAccount: true };
}

export function assertDisposableWorkspace(workspacePath, disposableRoot) {
  const root = path.resolve(disposableRoot);
  const workspace = path.resolve(workspacePath);
  const relative = path.relative(root, workspace);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Live smoke workspace must be a strict child of its disposable root.");
  }
  return workspace;
}

export function commandOutput(result) {
  const stdout = String(result?.stdout ?? "").trim();
  return stdout || String(result?.stderr ?? "").trim();
}

function readOnlyAuthority() {
  return {
    sandbox: "read-only",
    network: "off",
    browser: { inspect: false, mutate: false },
    process: { start: true, stopOwned: true },
    database: { read: false, write: false },
    externalEffects: { send: false, payment: false, deploy: false, delete: false },
    retry: false
  };
}

function startContract(workspacePath, lane) {
  return {
    schemaVersion: 1,
    workspacePath,
    limits: { maxActive: 1, maxWritersPerCheckout: 1, staggerMs: 0 },
    lanes: [{
      model: MODEL,
      effort: EFFORT,
      ephemeral: true,
      authority: readOnlyAuthority(),
      ...lane
    }]
  };
}

export function buildLiveSmokeContracts(workspacePath) {
  const workspace = path.resolve(workspacePath);
  return [
    startContract(workspace, {
      id: "live-investigator",
      role: "investigator",
      label: "Read-only live investigator",
      prompt: [
        "Reply exactly LIVE_INVESTIGATOR_OK.",
        "Do not call tools, edit files, or access the network."
      ].join(" ")
    }),
    startContract(workspace, {
      id: "live-verifier",
      role: "independent-verifier",
      label: "Independent live verifier",
      model: "gpt-5.6-terra",
      effort: "high",
      prompt: [
        "Independently reply exactly LIVE_VERIFIER_OK.",
        "Do not call tools, edit files, or access the network."
      ].join(" ")
    }),
    startContract(workspace, {
      id: "live-cancel",
      role: "investigator",
      label: "Owned cancellation probe",
      model: "gpt-5.6-luna",
      effort: "low",
      prompt: [
        "Run this read-only command and wait for it to finish:",
        `${JSON.stringify(process.execPath)} -e \"setTimeout(() => {}, 120000)\".`,
        "Do not do anything else."
      ].join(" ")
    })
  ];
}

function publicLane(lane) {
  return {
    id: lane?.id ?? null,
    model: lane?.model ?? null,
    effort: lane?.effort ?? null,
    status: lane?.status ?? null
  };
}

export function sanitizeLiveEvidence(raw) {
  const investigatorMessage = String(raw.investigator?.lastMessage ?? "");
  const followUpMessage = String(raw.followUp?.lastMessage ?? "");
  const verifierMessage = String(raw.verifier?.lastMessage ?? "");
  const threadReused = Boolean(
    raw.investigator?.threadId
    && raw.investigator.threadId === raw.followUp?.threadId
  );
  const turnChanged = Boolean(
    raw.investigator?.turnId
    && raw.followUp?.turnId
    && raw.investigator.turnId !== raw.followUp.turnId
  );
  const independentThread = Boolean(
    raw.verifier?.threadId
    && raw.verifier.threadId !== raw.investigator?.threadId
  );
  const evidence = {
    schemaVersion: 1,
    liveAccount: true,
    loginAuthenticated: /logged in/iu.test(String(raw.loginStatus ?? "")),
    codexVersion: String(raw.codexVersion ?? "").split(/\r?\n/u)[0].slice(0, 120),
    investigator: {
      ...publicLane(raw.investigator),
      markerObserved: investigatorMessage.includes("LIVE_INVESTIGATOR_OK")
    },
    followUp: {
      status: raw.followUp?.status ?? null,
      markerObserved: followUpMessage.includes("LIVE_FOLLOW_UP_OK"),
      threadReused,
      turnChanged
    },
    verifier: {
      ...publicLane(raw.verifier),
      markerObserved: verifierMessage.includes("LIVE_VERIFIER_OK"),
      independentThread
    },
    cancellation: {
      accepted: raw.cancellation?.accepted === true,
      status: raw.cancellation?.status ?? null
    }
  };
  evidence.passed = evidence.loginAuthenticated
    && evidence.investigator.status === "complete"
    && evidence.investigator.markerObserved
    && evidence.followUp.status === "complete"
    && evidence.followUp.markerObserved
    && evidence.followUp.threadReused
    && evidence.followUp.turnChanged
    && evidence.verifier.status === "complete"
    && evidence.verifier.markerObserved
    && evidence.verifier.independentThread
    && evidence.cancellation.accepted
    && evidence.cancellation.status === "cancelled";
  return evidence;
}

function isolatedEnvironment(disposableRoot) {
  const stateRoot = path.join(disposableRoot, "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  if (process.platform === "win32") {
    return { ...process.env, LOCALAPPDATA: stateRoot, FLEET_SUPERVISOR_IDLE_MS: "60000" };
  }
  return { ...process.env, XDG_STATE_HOME: stateRoot, FLEET_SUPERVISOR_IDLE_MS: "60000" };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "command failed")
      .replace(/[\u0000-\u001f]+/gu, " ")
      .slice(0, 1000);
    throw new Error(`${path.basename(command)} failed with exit ${result.status}: ${detail}`);
  }
  return commandOutput(result);
}

function runFleetJson(args, context) {
  return JSON.parse(run(process.execPath, [FLEET, ...args, "--json"], context));
}

function writeContract(disposableRoot, name, value) {
  const filePath = path.join(disposableRoot, `${name}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function laneFromResult(payload, laneId) {
  const lane = payload?.lanes?.find((candidate) => candidate.id === laneId);
  if (!lane) throw new Error(`Live smoke result omitted lane ${laneId}.`);
  return lane;
}

export async function cleanupDisposableRun(options = {}) {
  const disposableRoot = path.resolve(options.disposableRoot);
  const workspacePath = assertDisposableWorkspace(options.workspacePath, disposableRoot);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, disposableRoot);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Live smoke cleanup is restricted to the operating-system temp directory.");
  }
  const key = options.workspaceKey ?? await workspaceKey(workspacePath);
  const supervisorOptions = {
    dataDir: path.resolve(options.dataDir),
    workspaceKey: key,
    workspacePath,
    ...(options.supervisorOptions ?? {})
  };
  const manifest = options.manifest ?? await readSupervisorManifest(supervisorOptions);
  if (manifest) {
    const stopped = await stopSupervisor({ ...supervisorOptions, manifest });
    if (!stopped.stopped) {
      throw new Error(`Owned live-smoke supervisor did not stop: ${stopped.reason}.`);
    }
  }
  await fs.promises.rm(disposableRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}

export async function runLiveSmoke(options = {}) {
  if (options.confirmLiveAccount !== true) {
    throw new Error(`Real Codex account access requires exactly ${LIVE_FLAG}.`);
  }
  const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fleet-live-"));
  const workspace = assertDisposableWorkspace(path.join(disposableRoot, "workspace"), disposableRoot);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "FleetLiveSmoke disposable evidence\n", "utf8");
  const env = isolatedEnvironment(disposableRoot);
  const context = { cwd: workspace, env };
  const dataDir = getFleetDataDir(env, process.platform, os.homedir());
  const key = await workspaceKey(workspace);

  try {
    const codexVersion = run("codex", ["--version"], context);
    const loginStatus = run("codex", ["login", "status"], context);
    const [investigatorContract, verifierContract, cancelContract] =
      buildLiveSmokeContracts(workspace);

    const investigatorPath = writeContract(
      disposableRoot,
      "investigator",
      investigatorContract
    );
    runFleetJson(["start", "--contract", investigatorPath], context);
    const initialSupervisor = await readSupervisorManifest({ dataDir, workspaceKey: key });
    if (!initialSupervisor) throw new Error("Live supervisor disappeared after lane start.");
    const first = laneFromResult(runFleetJson([
      "result", "--workspace", workspace, "--lane", "live-investigator",
      "--wait", "--timeout-ms", String(RESULT_TIMEOUT_MS)
    ], context), "live-investigator");
    const followUpSupervisor = await readSupervisorManifest({ dataDir, workspaceKey: key });
    if (
      !followUpSupervisor
      || followUpSupervisor.process.pid !== initialSupervisor.process.pid
      || followUpSupervisor.process.recordedStart !== initialSupervisor.process.recordedStart
    ) {
      throw new Error("Live supervisor continuity was lost before follow-up.");
    }

    const followUpPath = writeContract(disposableRoot, "follow-up", {
      schemaVersion: 1,
      workspacePath: workspace,
      laneId: "live-investigator",
      message: "Reply exactly LIVE_FOLLOW_UP_OK. Do not call tools or access the network."
    });
    runFleetJson(["follow-up", "--contract", followUpPath], context);
    const followUp = laneFromResult(runFleetJson([
      "result", "--workspace", workspace, "--lane", "live-investigator",
      "--wait", "--timeout-ms", String(RESULT_TIMEOUT_MS)
    ], context), "live-investigator");

    const verifierPath = writeContract(disposableRoot, "verifier", verifierContract);
    runFleetJson(["start", "--contract", verifierPath], context);
    const verifier = laneFromResult(runFleetJson([
      "result", "--workspace", workspace, "--lane", "live-verifier",
      "--wait", "--timeout-ms", String(RESULT_TIMEOUT_MS)
    ], context), "live-verifier");

    const cancelPath = writeContract(disposableRoot, "cancel-start", cancelContract);
    runFleetJson(["start", "--contract", cancelPath], context);
    const previewPath = writeContract(disposableRoot, "cancel-preview", {
      schemaVersion: 1,
      workspacePath: workspace,
      laneId: "live-cancel"
    });
    const preview = runFleetJson(["cancel", "--contract", previewPath], context);
    const confirmPath = writeContract(disposableRoot, "cancel-confirm", {
      schemaVersion: 1,
      workspacePath: workspace,
      laneId: "live-cancel",
      expectedThreadId: preview.expectedThreadId,
      expectedTurnId: preview.expectedTurnId,
      confirmationToken: preview.confirmationToken
    });
    const accepted = runFleetJson([
      "cancel", "--contract", confirmPath, "--confirm"
    ], context);
    const cancelled = laneFromResult(runFleetJson([
      "result", "--workspace", workspace, "--lane", "live-cancel",
      "--wait", "--timeout-ms", "30000"
    ], context), "live-cancel");

    const evidence = sanitizeLiveEvidence({
      codexVersion,
      loginStatus,
      investigator: first,
      followUp,
      verifier,
      cancellation: { accepted: accepted.accepted, status: cancelled.status }
    });
    return evidence;
  } finally {
    await cleanupDisposableRun({
      disposableRoot,
      workspacePath: workspace,
      dataDir,
      workspaceKey: key
    });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseLiveSmokeArguments(process.argv.slice(2));
    const result = await runLiveSmoke(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
