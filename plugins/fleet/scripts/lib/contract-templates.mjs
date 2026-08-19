import path from "node:path";

const DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "research",
    role: "investigator",
    confirmationRequired: false,
    description: "Read-only workspace investigation with file evidence."
  }),
  Object.freeze({
    name: "implementation",
    role: "implementer",
    confirmationRequired: true,
    description: "One workspace writer that implements and verifies a bounded change."
  }),
  Object.freeze({
    name: "verification",
    role: "independent-verifier",
    confirmationRequired: false,
    description: "Fresh read-only verification against observable evidence."
  }),
  Object.freeze({
    name: "image-generation",
    role: "visual-analyst",
    confirmationRequired: true,
    description: "One confirmed GPT Image 2 artifact through Codex built-in $imagegen."
  })
]);

const BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

function authority({ writable = false, imageGenerate = false } = {}) {
  return {
    sandbox: writable ? "workspace-write" : "read-only",
    network: "off",
    browser: { inspect: false, mutate: false },
    process: { start: true, stopOwned: false },
    database: { read: false, write: false },
    image: { generate: imageGenerate, edit: false },
    externalEffects: { send: false, payment: false, deploy: false, delete: false },
    retry: false
  };
}

function promptFor(name, objective) {
  if (name === "research") {
    return [
      `Objective: ${objective}`,
      "Inputs: Inspect only the approved workspace and cite exact project-relative file evidence.",
      "Exclusions: Do not edit files, access the network, invoke a browser, or perform external effects.",
      "Authority: Read-only workspace access; process.start authorizes only this Fleet Codex lane.",
      "Capability evidence: Confirm required workspace files are readable before investigating.",
      "Deliverable: Return a concise verdict followed by project-relative evidence references.",
      "Verification: Re-open the cited evidence and distinguish observed facts from inference.",
      "Stop conditions: Stop on missing inputs, conflicting evidence, or any need for wider authority.",
      "Cleanup: Remove only lane-owned temporary resources; preserve the workspace unchanged."
    ].join("\n");
  }
  if (name === "implementation") {
    return [
      `Objective: ${objective}`,
      "Inputs: Use only the approved workspace and the user-confirmed bounded objective.",
      "Exclusions: Do not access the network, mutate browsers or databases, deploy, send, delete, or widen scope.",
      "Authority: One workspace writer; no image generation or external effects.",
      "Capability evidence: Inspect the target and current worktree state before editing.",
      "Deliverable: Implement the objective and return changed project-relative paths.",
      "Verification: Run the smallest environment-relevant checks and report their exact outcome.",
      "Stop conditions: Stop on unrelated dirty changes, ambiguity, denied authority, or unsafe mutation.",
      "Cleanup: Remove only lane-owned temporary files and processes."
    ].join("\n");
  }
  if (name === "verification") {
    return [
      `Objective: ${objective}`,
      "Inputs: Independently inspect the requested outcome and its evidence; do not rely on worker reasoning.",
      "Exclusions: Do not edit files, access the network, or perform external effects.",
      "Authority: Fresh read-only independent-verifier lane.",
      "Capability evidence: Confirm the claimed artifact and verification surface are reachable.",
      "Deliverable: Return pass, fail, or blocked with project-relative evidence references.",
      "Verification: Re-run the relevant checks and attempt to falsify the worker claim.",
      "Stop conditions: Stop when evidence is missing, ambiguous, environment-mismatched, or out of authority.",
      "Cleanup: Preserve all inspected artifacts and remove only verifier-owned temporary resources."
    ].join("\n");
  }
  return [
    `Objective: ${objective}`,
    "Inputs: Use Codex built-in $imagegen (GPT Image 2); name exact source images when editing is requested.",
    "Exclusions: Do not use API-key scripts, another provider, network fallback, copyrighted characters, or unapproved text/logos.",
    "Authority: Write only inside the approved workspace and perform one confirmed image generation; no external effects.",
    "Capability evidence: If $imagegen is unavailable or denied in this lane, stop without substituting another generator.",
    "Deliverable: Copy the selected result from generated_images to a new workspace path and return that workspace-relative path.",
    "Verification: Verify file existence, type, dimensions, and visual fit. The parent Claude must open the returned image with its Read tool before presenting it.",
    "Stop conditions: Stop on missing artifact, wrong provider, denied tool, ambiguous composition, or any need for broader authority.",
    "Cleanup: Preserve the delivered image and source images; remove only lane-owned intermediate files."
  ].join("\n");
}

export function listContractTemplates() {
  return DEFINITIONS.map((definition) => ({ ...definition }));
}

export function contractTemplateDefinition(name) {
  return BY_NAME.get(name) ?? null;
}

export function buildStartContractTemplate(options) {
  const definition = contractTemplateDefinition(options.name);
  if (!definition) throw new TypeError(`Unknown Fleet template: ${String(options.name)}.`);
  const writable = definition.name === "implementation" || definition.name === "image-generation";
  const imageGenerate = definition.name === "image-generation";
  const workspacePath = path.resolve(options.workspacePath);
  return {
    schemaVersion: 1,
    workspacePath,
    limits: { maxActive: 1, maxWritersPerCheckout: 1, staggerMs: 0 },
    confirmationRef: definition.confirmationRequired ? options.confirmationRef : null,
    lanes: [{
      id: `${definition.name}-1`,
      role: definition.role,
      label: definition.description,
      model: "gpt-5.6-sol",
      effort: "medium",
      prompt: promptFor(definition.name, options.objective),
      authority: authority({ writable, imageGenerate }),
      checkoutKey: `${definition.name}-checkout`,
      priority: "normal"
    }]
  };
}
