import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scoreCase } from "../scripts/run-skill-evals.mjs";
import {
  buildStartContractTemplate,
  listContractTemplates
} from "../plugins/fleet/scripts/lib/contract-templates.mjs";

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
    "Cleanup",
    "Execution posture"
  ]) {
    assert.match(contract, new RegExp(term, "i"));
  }
  assert.match(contract, /immutable/i);
  assert.match(contract, /prompt.*128 KiB/i);
  assert.match(contract, /"confirmationRef": null/);
  assert.match(contract, /"priority": "normal"/);
  assert.match(contract, /"image": \{ "generate": false, "edit": false \}/);
  assert.match(contract, /admitted.*contract.*authorization/is);
  assert.match(contract, /do not.*redundant approval/is);
  assert.match(contract, /continue_within_authority/);
  assert.match(contract, /needs_controller/);
  for (const field of [
    "evidenceRefs",
    "artifactRefs",
    "controllerRequest",
    "stopReason"
  ]) {
    assert.match(contract, new RegExp(`\\b${field}\\b`));
  }
  assert.match(contract, /mutable.*malformed.*outcome_unknown/is);
});

test("every init template executes immediately without a redundant approval gate", () => {
  for (const definition of listContractTemplates()) {
    const contract = buildStartContractTemplate({
      name: definition.name,
      objective: "Perform and verify the bounded objective.",
      workspacePath: process.cwd(),
      confirmationRef: definition.confirmationRequired ? "user-request" : null
    });
    const prompt = contract.lanes[0].prompt;

    assert.match(prompt, /Execution posture:/i, definition.name);
    assert.match(prompt, /admitted Fleet contract is authorization/i, definition.name);
    assert.match(prompt, /do not.*redundant approval/is, definition.name);
    assert.match(prompt, /never widen authority/i, definition.name);
  }
});

test("orchestrator safely continues redundant approval gates in the same Codex task", async () => {
  const skill = await read("SKILL.md");

  assert.match(skill, /same Codex (task|thread)/i);
  assert.match(skill, /redundant.*approval/is);
  assert.match(skill, /already-granted authority/i);
  assert.match(skill, /at most two.*follow-up/is);
  assert.match(skill, /new (scope|authority|user choice).*stop/is);
  assert.match(skill, /Ctrl\+G/i);
  assert.match(skill, /immediately after dispatching.*before waiting/is);
  assert.match(skill, /down-arrow.*separate\s+interface/is);
});

test("image lanes use Codex built-in GPT Image 2 routing and workspace artifacts", async () => {
  const routing = await read("references/capability-routing.md");

  assert.match(routing, /\$imagegen/);
  assert.match(routing, /GPT Image 2/i);
  assert.match(routing, /built-in.*preferred/is);
  assert.match(routing, /generated_images/is);
  assert.match(routing, /copy.*workspace/is);
  assert.match(routing, /image\.generate.*image\.edit/is);
});

test("parent Claude opens every returned image artifact before presenting it", async () => {
  const [skill, agent, routing] = await Promise.all([
    read("SKILL.md"),
    readFile(new URL("../../agents/codex-lane.md", skillRoot), "utf8"),
    read("references/capability-routing.md")
  ]);

  assert.match(agent, /image artifact.*workspace-relative path/is);
  assert.match(skill, /parent Claude.*Read tool.*visual/is);
  assert.match(routing, /path alone is not visual evidence/is);
  assert.match(routing, /fresh visual verifier/is);
});

test("operator docs expose init templates and the exact verifier role literal", async () => {
  const [readme, contracts] = await Promise.all([
    readFile(new URL("../../../../README.md", skillRoot), "utf8"),
    read("references/contracts.md")
  ]);

  assert.match(readme, /fleet\.mjs" init --list/is);
  assert.match(readme, /image-generation.*confirmation-ref/is);
  assert.match(contracts, /role.*exact literal.*independent-verifier/is);
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

test("live skill evals cannot start user-global MCP servers", async () => {
  const runner = await readFile(
    new URL("../scripts/run-skill-evals.mjs", import.meta.url),
    "utf8"
  );

  assert.match(runner, /--strict-mcp-config/);
  assert.match(runner, /mcpServers:\s*\{\}/);
});
