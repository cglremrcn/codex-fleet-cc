import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { CONSOLE_TICK_MS } from "../plugins/fleet/scripts/lib/console-controller.mjs";
import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";
import {
  buildViewModel,
  renderScreen
} from "../plugins/fleet/scripts/lib/tui-render.mjs";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(import.meta.dirname, "..");
const MEBIBYTE = 1024 * 1024;

export const PERFORMANCE_BUDGETS = Object.freeze({
  startupP95Ms: 250,
  idleCpuAveragePercent: 1,
  redrawHz: 4,
  retainedHeapMiB: 64,
  stateBytes: 2 * MEBIBYTE,
  orphanCount: 0
});

export function evaluatePerformance(metrics, budgets = PERFORMANCE_BUDGETS) {
  const violations = [];
  for (const [metric, maximum] of Object.entries(budgets)) {
    const actual = metrics[metric];
    if (!Number.isFinite(actual) || actual > maximum) {
      violations.push({ metric, actual: actual ?? null, maximum });
    }
  }
  return Object.freeze({ ok: violations.length === 0, violations });
}

function percentile95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

async function runJsonScript(script, args = [], timeout = 30_000) {
  const { stdout } = await execFile(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: MEBIBYTE,
    windowsHide: true
  });
  return JSON.parse(stdout.trim());
}

function performanceSnapshot() {
  const lanes = Array.from({ length: 256 }, (_, index) => ({
    id: `lane-${String(index).padStart(3, "0")}`,
    role: index % 3 === 0 ? "implementer" : "investigator",
    label: `Bounded lane ${index}`,
    model: "gpt-5.6-sol",
    effort: "high",
    status: index % 4 === 0 ? "running" : "complete",
    phase: "measurement",
    authority: { sandbox: "read-only", network: "off" }
  }));
  return {
    schemaVersion: 1,
    workspace: { name: "performance-fixture", branch: "main" },
    runtime: { health: "ready", protocol: "compatible", activeLimit: 3 },
    lanes
  };
}

async function sampleIdleCpu(durationMs = 500) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const elapsedMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return ((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100;
}

async function measureIdleCpu() {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const samples = [];
  for (let index = 0; index < 5; index += 1) samples.push(await sampleIdleCpu());
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
}

export async function measurePerformance() {
  const startupSamples = [];
  const consoleScript = path.join(ROOT, "plugins", "fleet", "scripts", "fleet-console.mjs");
  for (let index = 0; index < 7; index += 1) {
    const sample = await runJsonScript(consoleScript, ["--benchmark-startup", "--plain"]);
    startupSamples.push(sample.startupMs);
  }

  const snapshot = performanceSnapshot();
  const heapBefore = process.memoryUsage().heapUsed;
  const view = buildViewModel(snapshot, 0, "lanes");
  for (let index = 0; index < 20; index += 1) {
    renderScreen(view, { columns: 160, rows: 50 }, {
      color: false,
      unicode: true,
      reducedMotion: false,
      frame: index
    });
  }
  const retainedHeapMiB = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / MEBIBYTE;
  const idleCpuAveragePercent = await measureIdleCpu();
  const pty = await runJsonScript(path.join(ROOT, "scripts", "run-pty-smoke.mjs"), [
    "--assert-clean-terminal",
    "--assert-draft-unchanged"
  ]);

  const metrics = Object.freeze({
    startupP95Ms: percentile95(startupSamples),
    idleCpuAveragePercent,
    redrawHz: 1_000 / CONSOLE_TICK_MS,
    retainedHeapMiB,
    stateBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    orphanCount: pty.ownedChildrenAfterExit
  });
  const gate = evaluatePerformance(metrics);
  return Object.freeze({
    schemaVersion: 1,
    ok: gate.ok,
    metrics,
    budgets: PERFORMANCE_BUDGETS,
    violations: gate.violations
  });
}

if (isMainModule(import.meta.url)) {
  try {
    const report = await measurePerformance();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Performance check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
