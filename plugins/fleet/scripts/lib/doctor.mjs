import { spawn } from "node:child_process";
import process from "node:process";

import { redactText } from "./redaction.mjs";

export const CAPABILITY_STATES = Object.freeze([
  "available",
  "configured",
  "smoke_passed",
  "denied",
  "unknown"
]);

const CORE_CHECKS = new Set(["node", "claude", "codex", "broker", "state"]);
const COMMAND_ARGUMENTS = Object.freeze({
  node: ["--version"],
  claude: ["--version"],
  codex: ["--version"]
});

function boundedDetail(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return redactText(String(value)).slice(0, 512);
}

function safeDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pid = Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
  const currentIdentity = ["missing", "different", "same", "unknown"].includes(
    value.currentIdentity
  ) ? value.currentIdentity : "unknown";
  return Object.freeze({
    reasonCode: boundedDetail(value.reasonCode),
    action: value.action === "not_stopped" ? "not_stopped" : "unknown",
    pid,
    recordedIdentityPresent: value.recordedIdentityPresent === true,
    currentIdentity,
    remediation: boundedDetail(value.remediation)
  });
}

function capabilityState(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "unknown";
  }
  if (result.denied === true) return "denied";
  if (result.unknown === true) return "unknown";
  if (result.smokePassed === true) return "smoke_passed";
  if (result.configured === true) return "configured";
  if (result.available === true) return "available";
  return "unknown";
}

export function probeCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let child;
    let timer = null;
    let killGraceTimer = null;

    try {
      const spawnProcess = options.spawnProcess ?? spawn;
      child = spawnProcess(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ unknown: true, detail: error.message });
      return;
    }

    const finish = (result, detach = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (detach) child.unref?.();
      resolve(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // The close/error events or the bounded grace timer finish cleanup.
      }
      killGraceTimer = setTimeout(() => {
        finish({ unknown: true, detail: `${command} probe timed out` }, true);
      }, options.killGraceMs ?? 1_000);
    }, options.timeoutMs ?? 4_000);

    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(0, 1_024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(0, 1_024);
    });
    child.once("error", (error) => finish({ unknown: true, detail: error.message }, true));
    child.once("close", (code) => {
      if (timedOut) {
        finish({ unknown: true, detail: `${command} probe timed out` });
        return;
      }
      const detail = (stdout.trim() || stderr.trim()).split(/\r?\n/u)[0] ?? null;
      finish(code === 0
        ? { available: true, version: detail, detail }
        : { unknown: true, detail: detail || `${command} exited ${String(code)}` });
    });
  });
}

async function defaultCommandProbe(name, context) {
  if (name === "node") {
    return { available: true, version: process.version, detail: process.version };
  }
  return probeCommand(name, COMMAND_ARGUMENTS[name] ?? ["--version"], context);
}

async function defaultAuthProbe(context) {
  const result = await probeCommand("codex", ["login", "status"], context);
  if (result.available) {
    return { configured: true, detail: result.detail };
  }
  return result;
}

async function unknownProbe(label) {
  return { unknown: true, detail: `${label} probe was not provided` };
}

async function collectCheck(id, probe, context) {
  try {
    const result = await probe(context);
    const diagnostic = safeDiagnostic(result?.diagnostic);
    return Object.freeze({
      id,
      state: capabilityState(result),
      detail: boundedDetail(result?.detail ?? result?.version ?? result?.protocol),
      evidence: Object.freeze({
        version: boundedDetail(result?.version),
        protocol: boundedDetail(result?.protocol),
        unicode: result?.unicode === true,
        color: result?.color === true,
        shortcut: boundedDetail(result?.shortcut)
      }),
      ...(diagnostic ? { diagnostic } : {})
    });
  } catch (error) {
    const diagnostic = safeDiagnostic(error?.diagnostic);
    return Object.freeze({
      id,
      state: "unknown",
      detail: boundedDetail(error?.message ?? error),
      evidence: Object.freeze({}),
      ...(diagnostic ? { diagnostic } : {})
    });
  }
}

function overallState(checks) {
  if (checks.some((check) => CORE_CHECKS.has(check.id)
    && (check.state === "denied" || check.state === "unknown"))) {
    return "blocked";
  }
  if (checks.some((check) => check.state === "denied" || check.state === "unknown")) {
    return "attention";
  }
  return "ready";
}

export async function runDoctor(options = {}) {
  const context = Object.freeze({
    mutate: false,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 4_000
  });
  const commandProbe = options.commandProbe ?? defaultCommandProbe;
  const checks = [];

  for (const name of ["node", "claude", "codex"]) {
    checks.push(await collectCheck(name, (probeContext) => commandProbe(name, probeContext), context));
  }
  checks.push(await collectCheck(
    "codex-auth",
    options.authProbe ?? defaultAuthProbe,
    context
  ));
  checks.push(await collectCheck(
    "broker",
    options.brokerProbe ?? (() => unknownProbe("broker")),
    context
  ));
  checks.push(await collectCheck(
    "state",
    options.stateProbe ?? (() => unknownProbe("state")),
    context
  ));
  checks.push(await collectCheck(
    "editor",
    options.editorProbe ?? (() => unknownProbe("editor")),
    context
  ));
  checks.push(await collectCheck(
    "terminal",
    options.terminalProbe ?? (() => unknownProbe("terminal")),
    context
  ));

  const capabilityProbes = options.capabilityProbes ?? {};
  for (const id of ["web", "browser", "image"]) {
    const probe = typeof capabilityProbes[id] === "function"
      ? capabilityProbes[id]
      : () => unknownProbe(id);
    checks.push(await collectCheck(id, probe, context));
  }
  for (const id of Object.keys(capabilityProbes).sort()) {
    if (!["web", "browser", "image"].includes(id)
      && typeof capabilityProbes[id] === "function") {
      checks.push(await collectCheck(id, capabilityProbes[id], context));
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    overall: overallState(checks),
    checks: Object.freeze(checks)
  });
}
