---
name: codex-fleet-orchestrator
description: Orchestrate bounded Codex lanes from Claude Code for parallel research, implementation, browser QA, audits, and independent verification. Use when the user asks Claude to delegate to Codex, use a Codex fleet, run parallel agents, or coordinate Codex work across evidence surfaces.
---

# Codex Fleet Orchestrator

Claude is the orchestrator. Codex lanes are bounded workers. Keep work in Claude when delegation would
cost more coordination than it saves; use one lane by default and add lanes only for genuinely independent
evidence surfaces.

## Non-negotiable invariants

- Roles do not grant authority. Declare every lane's filesystem, network, browser, process, database,
  image, retry, and external-effect authority explicitly; omitted authority is denied.
- A lane completion is a claim, not proof. Use a fresh independent verifier after implementation or any
  other consequential claim. A lane never verifies its own work.
- Run implementers and verifiers in separate waves. The verifier receives the requested outcome and
  resulting evidence, not the implementer's reasoning.
- Use at most one writer per physical workspace. Parallel writers require isolated, pre-created worktrees;
  different `checkoutKey` labels inside one workspace do not create isolation.
- Never silently substitute Claude, a different tool, a different account, cached search, or a mock when
  a requested capability is unavailable. State the failed capability evidence and the proposed fallback.
- Never retry an external or filesystem mutation with an unknown outcome until authoritative
  reconciliation.
- Dashboard navigation, status reads, result waits, watch events, catalogue reads, and recovery probes are
  control-plane operations; they must not create model turns merely to observe Fleet.

## Reference routing

Read only the references required for the current task, but read each selected file completely before
building lane contracts:

- Read [capability-routing.md](references/capability-routing.md) before any web, browser, image, database,
  MCP, or external-tool lane, or whenever tool availability is uncertain.
- Read [contracts.md](references/contracts.md) before dispatching any lane.
- Read [fleet-patterns.md](references/fleet-patterns.md) when choosing lane count, waves, worktrees,
  model/effort, shared context, or shared-resource ownership.
- Read [evidence-and-verification.md](references/evidence-and-verification.md) for audits, diagnosis,
  implementation, QA, research, or any completion claim.
- Read [browser-and-external-effects.md](references/browser-and-external-effects.md) before browser,
  account, message, payment, deploy, delete, or database-write work.
- Read [recovery.md](references/recovery.md) after interruption, timeout, broker failure, partial
  completion, capability denial, corrupt state, unknown outcome, or a queued lane that cannot start.

## Orchestration loop

### 1. Bound the outcome

Restate the concrete deliverable, in-scope systems, excluded actions, proof required, and terminal
condition. Preserve explicit user constraints. Ask only when a missing choice would materially change
scope or authority.

Before a “missing” or “broken” claim, perform an existence check using names, synonyms, likely paths,
configuration, and available project memory. Presence is not wiring: prove the discovered item reaches
the execution path.

Before every dispatch, inspect current Fleet status/results and repository history for the lane ID,
deliverable, feature name, and likely commit message. A stale checklist is not authority to repeat work.
If the requested outcome already exists and its evidence is sufficient, report it instead of dispatching.
If an existing terminal lane needs more work inside the same authority, continue its real Codex thread
only when Fleet says it is resumable. Never reuse its lane ID for a new admission. A genuinely new attempt
receives a new stable ID and an explicit `retryOf`/reconciliation relationship when applicable.

For diagnosis, state a falsifiable hypothesis and the observation that would refute it. Collect that
observation before proposing a fix. After root cause, perform a class-wide sibling search and either
include each in-scope sibling or report it with evidence.

When a requirement contains a numerical or merge rule, state the empty/zero-input case explicitly. If
two rules disagree at zero, clarify before spending a model turn. Describe the invariant and merge
behavior, not only the trigger condition of one gate.

### 2. Prove capabilities and environment

For each required capability, run capability discovery followed by the smallest non-mutating smoke.
Record `available`, `configured`, `smoke_passed`, `denied`, or `unknown` separately. A configured MCP,
browser, network flag, login, binary, or API key is not proof that a lane can use it.

For a workspace writer, Fleet also performs zero-inference environment preflight before the first model
turn. A nested-process `EPERM`, missing local environment, or an editable Python package resolving to a
sibling worktree is a real boundary. Do not weaken sandbox authority to make a build green. Put checks
that require the host/controller environment in `verificationPlan.controller` and keep their status
`blocked`/`skipped` until they actually run.

Do not dispatch a lane that cannot reach a capability essential to useful work. If only a final delivery
check is unavailable but implementation remains safe/useful, do not turn that completion gate into a
start gate; record it as controller-owned verification instead. Never fabricate a PostgreSQL target,
remote font cache, browser, or provider evidence.

### 3. Choose the smallest topology

Start with one lane. Split only when tasks have independent inputs/evidence or when one brief contains too
many sequential deliverables. A practical implementation lane should normally contain no more than two
coherent deliverable slices and one migration. A four-part feature is normally four lanes/waves or a
smaller decomposition, not one multi-hour thread that repeatedly rereads itself.

Prefer sequential waves over a large fleet:

1. investigators/researchers;
2. planner only when synthesis is non-trivial;
3. implementer wave;
4. integrator when isolated writers produced changes;
5. fresh verifier;
6. browser/production QA only in the environment explicitly authorized.

Default runtime limits are three active lanes, one writer per physical workspace, and staggered starts.
Lower limits when the task, host, provider, or account is sensitive. Do not parallelize mutable browser
profiles, tenants, databases, deployment targets, payment flows, or message senders.

For parallel writers, create real separate worktrees and prepare each worktree's trustworthy dependencies.
A shared editable venv is not safe evidence. Use qualified `<workspaceKey>:<laneId>` `retryOf` when a
retry moves across workspace ledgers.

### 4. Assign authority, shared context, and verification plan

Build an authority matrix before prompts. Read-only is the default. `workspace-write`, live network,
browser mutation, database write, send, payment, deploy, delete, retry, and owned-process stop are
independent grants. State-changing work requires a visible preview and the user's explicit confirmation
reference before dispatch.

Create one immutable contract per lane using [contracts.md](references/contracts.md). Include objective,
inputs, exclusions, authority, capability evidence, deliverable, stop conditions, and cleanup. Put stable
workspace rules shared by sibling lanes in root `sharedContext` rather than copying the same 6–9 KiB text
into every prompt.

Use machine `verificationPlan` to separate:

- `start`: true prerequisites for useful work;
- `completion`: checks the lane should attempt before claiming completion;
- `controller`: checks that require the host/controller/real external environment.

Include the execution posture: an admitted Fleet contract is authorization to execute and verify now,
not to stop at a plan or ask for redundant approval. Do not put secrets, cookies, tokens, personal data,
or hidden reasoning in the contract.

For mutation testing, require proof that the mutation actually applied before interpreting the result.
Do not use an assumed Windows `/tmp`; use a verified workspace scratch path. A gate should measure
behavior, not pin incidental source text unless exact text is the contract. Never make one gate pass by
moving behavior into another gate's known blind spot.

### 5. Dispatch and control through Fleet only

Pass `start`, `status`, `result`, `follow-up`, cancellation and recovery control through Fleet. The top-level
entrypoint resolves ordinary control commands through the applied ownership-manifest integration runtime,
so do not manually select an older cached plugin version. `setup`/`uninstall` remain on the installed
plugin surface because they own the version transition.

For a start, pass the complete root contract:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" start --stdin --json
```

Do not invoke Codex through an ad-hoc shell command or bypass Fleet's authority and scheduling gates. Do
not edit an admitted lane contract. A new requirement is a bounded follow-up contract or a new lane.
Immediately after dispatching `start`, before waiting for admission or a terminal result, mention once
that `Ctrl+G` opens Fleet Console; Claude Code's down-arrow background-agent control is separate. After
admission, report the lane ID without repeating the hint.

Inside Fleet Console, `Enter` or `m` opens the selected real Codex thread, `Enter` sends a message, and
`Ctrl+G` returns to the Fleet dashboard before `q`/`Esc` returns to Claude Code.

Use `fleet --help` or `fleet <command> --help` for command syntax. Do not inspect `lib/cli.mjs` merely to
discover the follow-up or cancel schema.

Fleet requires a structured lane outcome. Plan-only/incomplete work may receive bounded automatic
continuation inside unchanged authority. When mutable implementation appears complete but the final
structured report is malformed, Fleet allows exactly one **report-only repair** in the same thread,
forced read-only and network-off. That repair may fix the report only; it may not redo implementation,
browse, mutate, or widen authority. A second malformed report remains `outcome_unknown` and requires
reconciliation.

New scope, new authority, a new external effect, missing input, an unresolved user choice, or a genuine
runtime blocker becomes `needs_controller`: Claude resolves what it can inside its authority and asks the
human only when a material human decision or confirmation is genuinely required. Never interpret
`complete` as successful work when requested work or evidence is absent.

For an image-authorized lane, do not decide availability from Claude Code's plugin/MCP inventory. Fleet
asks the target Codex app-server for `skills/list`, requires the enabled system skill `imagegen`, and
injects that exact skill. A pre-turn capability refusal means the target runtime did not expose a safe
ImageGen route; do not substitute another generator.

For every returned image artifact, parent Claude must resolve the workspace-relative path inside the
approved workspace and open it before presenting or approving it. Perform visual QA against composition,
text, brand, dimensions, and exclusions. Path existence alone is not visual evidence. Consequential
visual work also receives a fresh visual verifier after parent inspection.

### 6. Observe without polling or narrating noise

Use Fleet state for status. Report meaningful transitions, capability denial, required user action, queue
stall, and terminal outcomes—not every event. Static console viewing is the preferred zero-model-turn
path.

For one lane, use event-backed waiting:

```text
fleet result --lane <id> --wait --summary
```

The default wait is ten minutes. If it times out, say the lane is still non-terminal; do not call the
wait itself a failure. For the next meaningful Fleet event use:

```text
fleet watch --workspace <workspace>
```

Do not create shell `until ... sleep` watchers. A queued lane is not proof that execution started; inspect
`queueBlocker`, `startedAt`, `turnId`, and the watch event. When status returns sibling worktree ledger
hints, use the intended physical worktree path instead of concluding there are no lanes.

Token usage is shown only when Codex reports it. Distinguish cached input from fresh input; raw cumulative
thread input is not billing, quota, dollars, or a correctness metric.

### 7. Require environment-specific verification

Verification must match the claim: unit tests do not prove browser UX, mocks do not prove provider
integration, SQLite does not prove PostgreSQL behavior, and local green does not prove production.
Use a fresh verifier with read-only authority unless its verification method itself needs a narrower,
explicit capability.

A read-only verifier that should not write pytest caches may use `PYTHONDONTWRITEBYTECODE=1` and
`pytest -p no:cacheprovider` when appropriate. If the verifier should inspect controller-produced gate
evidence rather than rerun a host-only command, say so before dispatch.

Visual claims need browser/visual measurement. CSS can override correct data without appearing in a source
fixture. If browser evidence is unavailable, the claim remains unverified; do not convert source review
into visual proof.

### 8. Recover explicitly

After interruption, unknown outcome, or a continuation reservation, read [recovery.md](references/recovery.md).
The normal operator controls are:

```text
fleet reconcile <laneId> --workspace <workspace>
fleet resolve <laneId> --evidence <ref> --outcome complete --workspace <workspace>
fleet cancel <laneId> --workspace <workspace> --json
fleet archive <laneId> --workspace <workspace>
```

`reconcile --assume-not-started` is an evidence-backed override, not a timeout shortcut. `cancel` returns
`touchedFiles`; inspect them before cleanup. `archive` only hides terminal Fleet records and never deletes
workspace data.

A mutable `outcome_unknown` is deliberately not directly resumable. Reconcile actual effects first.
Never edit Fleet state.json by hand as an operational recovery method.

### 9. Synthesize evidence-first

Report verdict first, then evidence, confidence, what would change the verdict, residual risks, and
out-of-scope siblings. Separate observed facts, lane claims, verifier findings, and inference. Do not
upgrade `complete` to `verified`, `skipped` to `passed`, or `outcome_unknown` to failure/success.

Persist only sanitized result/evidence references. Never persist raw prompts, chain-of-thought, secrets,
cookies, full command output, or canonical private home paths.

## Stop immediately when

- required authority is absent or ambiguous;
- an essential capability smoke is denied, unknown, or reaches the wrong account/environment;
- a dirty/shared physical workspace makes concurrent writes unsafe;
- an external or filesystem effect may have happened but cannot yet be reconciled;
- the lane asks to broaden scope or bypass Fleet;
- evidence contradicts the plan's foundational assumption.

A controller-owned final verification gate being unavailable is not automatically a reason to throw away
safe completed implementation. Preserve the artifact, mark that gate `blocked`/`skipped`, and route the
exact check to the controller.

## Runtime model discovery

Before choosing a newly released model, run:

```text
fleet models --refresh --workspace <workspace> --json
```

Use the returned exact `model` and one of its `efforts`; set root `modelPolicy` to `runtime`. Catalogue
discovery starts no model turn. Refresh may restart only an idle runtime. Never invent an alias or
silently substitute a model when discovery fails. Existing compatibility contracts may omit
`modelPolicy`.

For multi-task work, give each lane a short logical `groupPath` such as `backend/auth` or
`release/security`. These folders are UI metadata only: no authority, checkout isolation, or filesystem
path is implied. Keep active parallelism bounded; many visible records do not justify many concurrent
model turns.

## Mid-turn intervention

For a job that needs interactive operator decisions, set the lane's `interactive: true`; keep its
existing sandbox and authority. This selects Codex on-request behavior, not permission to approve.
Read compact status pending counts and use the `inbox` skill when an agent is waiting. Propose a scoped
answer instead of copying whole transcripts or asking the user to restart work. Only answer a technical
question after the human delegates that exact request. Never use operator-only review endpoints, fake
confirmation, or repeated sends after uncertain delivery.