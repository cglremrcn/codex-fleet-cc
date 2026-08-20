---
name: codex-fleet-orchestrator
description: Orchestrate bounded Codex lanes from Claude Code for parallel research, implementation, browser QA, audits, and independent verification. Use when the user asks Claude to delegate to Codex, use a Codex fleet, run parallel agents, or coordinate Codex work across evidence surfaces.
---

# Codex Fleet Orchestrator

Claude is the orchestrator. Codex lanes are bounded workers. Keep work in Claude when delegation
would cost more coordination than it saves; use one lane by default and add lanes only for genuinely
independent evidence surfaces.

## Non-negotiable invariants

- Roles do not grant authority. Declare every lane's filesystem, network, browser, process,
  database, image, retry, and external-effect authority explicitly; omitted authority is denied.
- A lane completion is a claim, not proof. Use a fresh independent verifier after implementation or
  any other consequential claim. A lane never verifies its own work.
- Run implementers and verifiers in separate waves. The verifier receives the requested outcome and
  resulting evidence, not the implementer's reasoning.
- Use at most one writer per shared checkout. Parallel writers require isolated, pre-created
  worktrees and distinct `checkoutKey` values.
- Never silently substitute Claude, a different tool, a different account, cached search, or a mock
  when a requested capability is unavailable. State the failed capability evidence and the proposed
  fallback.
- Never retry an external mutation with an unknown outcome until authoritative reconciliation.
- Dashboard navigation and status reads are local operations; they must not create model turns.

## Reference routing

Read only the references required for the current task, but read each selected file completely before
building lane contracts:

- Read [capability-routing.md](references/capability-routing.md) before any web, browser, image,
  database, MCP, or external-tool lane, or whenever tool availability is uncertain.
- Read [contracts.md](references/contracts.md) before dispatching any lane.
- Read [fleet-patterns.md](references/fleet-patterns.md) when choosing lane count, waves, worktrees,
  model/effort, or shared-resource ownership.
- Read [evidence-and-verification.md](references/evidence-and-verification.md) for audits,
  diagnosis, implementation, QA, research, or any completion claim.
- Read [browser-and-external-effects.md](references/browser-and-external-effects.md) before browser,
  account, message, payment, deploy, delete, or database-write work.
- Read [recovery.md](references/recovery.md) after interruption, timeout, broker failure, partial
  completion, capability denial, corrupt state, or an unknown outcome.

## Orchestration loop

### 1. Bound the outcome

Restate the concrete deliverable, in-scope systems, excluded actions, proof required, and terminal
condition. Preserve explicit user constraints. Ask only when a missing choice would materially change
scope or authority.

Before a “missing” or “broken” claim, perform an existence check using names, synonyms, likely paths,
configuration, and available project memory. Presence is not wiring: prove the discovered item reaches
the execution path.

Before every dispatch, also inspect current Fleet status/results and repository history for the lane ID,
deliverable, feature name, and likely commit message. A stale checklist is not authority to repeat work.
If the requested outcome already exists and its evidence is sufficient, report it instead of dispatching.
If an existing terminal lane needs more work inside the same authority, continue its real Codex thread;
never reuse its lane ID for a new admission. A genuinely new attempt receives a new stable ID and an
explicit `retryOf`/reconciliation relationship when applicable.

For diagnosis, state a falsifiable hypothesis and the observation that would refute it. Collect that
observation before proposing a fix. After root cause, perform a class-wide sibling search and either
include each in-scope sibling or report it with evidence.

### 2. Prove capabilities

For each required capability, run capability discovery followed by the smallest non-mutating smoke.
Record `available`, `configured`, `smoke_passed`, `denied`, or `unknown` separately. A configured MCP,
browser, network flag, login, binary, or API key is not proof that a lane can use it.

Do not dispatch a lane that cannot reach its required capability. Either keep that surface in Claude,
with the user's requested authority, or stop and present the explicit fallback. Never widen authority
to make a smoke pass.

### 3. Choose the smallest topology

Start with one lane. Split only when tasks have independent inputs or evidence and can progress without
editing the same state. Prefer sequential waves over a large fleet:

1. investigators/researchers;
2. planner only when synthesis is non-trivial;
3. implementer wave;
4. integrator when isolated writers produced changes;
5. fresh verifier;
6. browser/production QA only in the environment explicitly authorized.

Default runtime limits are three active lanes, one writer per checkout, and staggered starts. Lower
limits when the task, host, provider, or account is sensitive. Do not parallelize mutable browser
profiles, tenants, databases, deployment targets, payment flows, or message senders.

### 4. Assign authority, then contracts

Build an authority matrix before prompts. Read-only is the default. `workspace-write`, live network,
browser mutation, database write, send, payment, deploy, delete, retry, and owned-process stop are
independent grants. State-changing work requires a visible preview and the user's explicit confirmation
reference before dispatch.

Create one immutable contract per lane using [contracts.md](references/contracts.md). Include objective,
inputs, exclusions, authority, capability evidence, deliverable, verification, stop conditions, and
cleanup. Include the execution posture: an admitted Fleet contract is authorization to execute and
verify now, not to stop at a plan or ask for redundant approval. Do not put secrets, cookies, tokens,
personal data, or hidden reasoning in the contract.

### 5. Dispatch and control through Fleet only

Pass `start`, `status`, `result`, `follow-up`, and cancellation-preview control requests to the
`fleet:codex-lane` agent. For a start, pass the complete root contract. The bridge admits it with:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" start --stdin --json
```

Do not invoke Codex through an ad-hoc shell command or bypass Fleet's authority and scheduling gates.
Do not edit an admitted lane contract. A new requirement is a new follow-up contract or a new lane.
Immediately after dispatching `start`, before waiting for admission or a terminal result, mention once
that `Ctrl+G` opens Fleet Console; Claude Code's down-arrow background-agent control is a separate
interface and does not enter Fleet. After admission, report the lane ID without repeating the hint.
Inside Fleet Console, `Enter` or `m` opens the selected real Codex
thread, `Enter` sends a message, and `Ctrl+G` returns to the Fleet dashboard before `q`/`Esc` returns to
Claude Code.

Fleet requires a structured lane outcome and automatically handles a plan-only answer, malformed
result, incomplete work, or redundant approval request as `continue_within_authority`. It sends a
precise bounded follow-up to the same Codex task/thread, preserves the already-granted authority, and
allows at most two automatic follow-up turns. Claude observes the resulting transition instead of
manually duplicating the continuation. New scope, new authority, a new external effect, missing input,
an unresolved user choice, or a third continuation becomes `needs_controller`: Claude resolves what
it can inside its own authority and asks the human only when a material human decision or confirmation
is genuinely required. Never interpret `complete` as successful work when requested work or
verification evidence is absent.

For an image-authorized lane, do not decide availability from Claude Code's plugin, MCP, or skill
inventory. Fleet asks the target Codex app-server for `skills/list`, requires the enabled system skill
named `imagegen`, and injects that exact skill into every image turn. A pre-turn capability refusal means
the target Codex runtime did not expose a safe ImageGen route; do not substitute another generator.

For every returned image artifact, the parent Claude must resolve the workspace-relative path inside
the approved workspace and open the file with its Read tool before presenting or approving
it. Perform visual QA against the requested composition, text, brand, dimensions, and exclusions; path
existence alone is not visual evidence. Consequential visual work also receives a fresh visual verifier
lane after parent inspection. Parent inspection and independent verification are separate evidence.

### 6. Observe without narrating noise

Use Fleet state for status. Report meaningful transitions, capability denial, required user action,
and terminal outcomes—not every event. Static console viewing is the preferred zero-model-turn path.
Token usage is shown only when Codex reports it; never infer subscription cost.

### 7. Require environment-specific verification

Verification must match the claim: unit tests do not prove browser UX, mocks do not prove provider
integration, SQLite does not prove PostgreSQL behavior, and local green does not prove production.
Use a fresh verifier with read-only authority unless its verification method itself needs a narrower,
explicit capability.

### 8. Synthesize evidence-first

Report verdict first, then evidence, confidence, what would change the verdict, residual risks, and
out-of-scope siblings. Separate observed facts, lane claims, verifier findings, and inference. Do not
upgrade `complete` to `verified`, or `OUTCOME_UNKNOWN` to failure or success.

Persist only sanitized result/evidence references. Never persist raw prompts, chain-of-thought, secrets,
cookies, full command output, or canonical private home paths.

## Stop immediately when

- required authority is absent or ambiguous;
- the capability smoke is denied, unknown, or reaches the wrong account/environment;
- a dirty/shared checkout makes concurrent writes unsafe;
- an external effect may have happened but cannot yet be reconciled;
- the lane asks to broaden scope or bypass Fleet;
- evidence contradicts the plan's foundational assumption.

On stop, preserve completed evidence, avoid cleanup outside proven Fleet ownership, and route through
[recovery.md](references/recovery.md).
