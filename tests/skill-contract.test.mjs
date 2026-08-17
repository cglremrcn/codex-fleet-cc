import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scoreCase } from "../scripts/run-skill-evals.mjs";

const skillRoot = new URL(
  "../plugins/fleet/skills/codex-fleet-orchestrator/",
  import.meta.url
);

async function read(relativePath) {
  return readFile(new URL(relativePath, skillRoot), "utf8");
}

test("orchestrator forbids authority by role and same-lane verification", async () => {
  const skill = await read("SKILL.md");

  assert.match(skill, /roles do not grant authority/i);
  assert.match(skill, /fresh.*verifier/i);
  assert.match(skill, /capability discovery.*smoke/i);
  assert.match(skill, /one lane by default/i);
  assert.match(skill, /existence check/i);
  assert.match(skill, /hypothesis.*refut/i);
  assert.match(skill, /class-wide sibling/i);
  assert.match(skill, /environment.*verification/i);
});

test("entry skill is concise and routes each risk surface to one reference", async () => {
  const skill = await read("SKILL.md");
  const lines = skill.split(/\r?\n/);

  assert.ok(lines.length < 350, `SKILL.md is ${lines.length} lines`);
  for (const reference of [
    "capability-routing.md",
    "contracts.md",
    "fleet-patterns.md",
    "evidence-and-verification.md",
    "browser-and-external-effects.md",
    "recovery.md"
  ]) {
    assert.match(skill, new RegExp(reference.replace(".", "\\.")));
    assert.match(await read(`references/${reference}`), /^# /);
  }
});

test("lane contract requires bounded work, authority, evidence, and cleanup", async () => {
  const contract = await read("references/contracts.md");

  for (const term of [
    "Objective",
    "Inputs",
    "Exclusions",
    "Authority",
    "Capability evidence",
    "Deliverable",
    "Verification",
    "Stop conditions",
    "Cleanup"
  ]) {
    assert.match(contract, new RegExp(term, "i"));
  }
  assert.match(contract, /immutable/i);
  assert.match(contract, /prompt.*128 KiB/i);
});

test("browser and external effects fail closed without silent substitution", async () => {
  const browser = await read("references/browser-and-external-effects.md");

  assert.match(browser, /existing signed-in session/i);
  assert.match(browser, /one operator/i);
  assert.match(browser, /silent (fallback|substitution).*forbidden/i);
  assert.match(browser, /send.*payment.*deploy.*delete/is);
  assert.match(browser, /explicit confirmation/i);
});

test("recovery prevents blind retry after an unknown outcome", async () => {
  const recovery = await read("references/recovery.md");

  assert.match(recovery, /OUTCOME_UNKNOWN/);
  assert.match(recovery, /reconcil/i);
  assert.match(recovery, /never.*blind.*retry/i);
  assert.match(recovery, /owned process/i);
});

test("forward cases cover the mandatory fleet routing surfaces", async () => {
  const cases = JSON.parse(await readFile(
    new URL("./fixtures/skill-cases.json", import.meta.url),
    "utf8"
  ));
  const ids = new Set(cases.map((entry) => entry.id));

  assert.equal(cases.length, 7);
  for (const id of [
    "atomic-code-review",
    "live-web-research",
    "existing-session-browser-qa",
    "shared-checkout-writer",
    "isolated-worktree-writers",
    "unknown-external-outcome",
    "unavailable-capability"
  ]) {
    assert.equal(ids.has(id), true, `missing fixture ${id}`);
  }
});

test("fleet counts include sequential integrator and verifier lanes", async () => {
  const patterns = await read("references/fleet-patterns.md");

  assert.match(patterns, /count every Codex lane across all sequential waves/i);
  assert.match(patterns, /integrator.*fresh verifier.*still a lane/is);
  assert.match(patterns, /one researcher followed by one.*fresh verifier.*two lanes total/is);
  assert.match(patterns, /integrator.*counts as a writer/is);
});

test("eval scorer distinguishes prior effects from newly proposed mutation", () => {
  const entry = {
    expected: {
      automaticRetry: false,
      requiresReconciliation: true,
      newExternalMutation: false,
      outcome: "reconcile"
    }
  };
  const score = scoreCase(entry, {
    automaticRetry: false,
    requiresReconciliation: true,
    newExternalMutation: false,
    routeOutcome: "reconcile"
  });

  assert.equal(score.passed, true);
  assert.equal(score.score, 1);
});
