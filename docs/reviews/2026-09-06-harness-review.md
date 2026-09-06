# Claude-centered Codex Fleet: engineering review and first implementation

**Date:** 2026-09-06. **Reviewed upstream:** `c762ca10c218cfe16b6b6bf69de5d07ccfe55a54`
(v0.2.1). **Status:** implementation proposed for review, not a released or production-certified harness.

## Executive decision

Keep Claude Code as the human-facing orchestrator and keep Codex app-server as the worker runtime.
Do not rewrite Fleet into a generic chat dashboard, spawn a CLI per observation, or remove authority
checks to expose more tools. Improve three separate systems: the **observation plane** (what exists
and what happened), the **control plane** (who may change which exact turn), and the **evidence plane**
(what proves the requested result at a specific revision). Model quality does not replace those planes.

The first implementation addresses demonstrable local weaknesses: navigability, stale model
validation, missing usage propagation, oversized controller status, shared-root writer identity,
stale-turn notifications and repeated/poisoned durable writes. It is a useful foundation, not the
completion of every recommendation in this report. There is no measured basis for a “world's best”
claim or a percentage improvement in real coding quality.

## Scope and evidence discipline

The pinned repository contains 178 tracked files. The review inventoried its source, plugin,
upstream compatibility layer, tests, fixtures, documentation, CI and release surfaces. Runtime,
scheduler, controller, contract validation, persistence, hooks, packaging and verification boundaries
received focused execution-path review. Existing documentation was treated as a claim to check, not
proof that the execution path implements it. This was not a formal line-by-line proof of every file,
a penetration test of the user's machine, or a live authenticated model comparison.

Source was obtained through the GitHub connector and a branch-only tracked-source artifact because
container DNS could not clone GitHub or install from npm. A temporary source-export workflow was
used on the review branch; transport-only workflows must not remain in the final PR diff. No main
branch update, release publication, credentials upload, live model run or merge was authorized by
this implementation. Publishing a review branch and draft PR is the intended external change.

Labels below mean **OBSERVED** (reachable code), **REPRODUCED** (a failing local regression),
**IMPLEMENTED** (changed and locally exercised), or **PROPOSAL** (not delivered behavior).

## What should be preserved

Fleet already has more substance than a prompt wrapper. The supported external-editor handoff
preserves the Claude draft and terminal; one broker serves bounded lanes; follow-ups use the same
Codex thread; cancellation uses exact owned identity. Contracts separate roles from capabilities.
Unknown external outcomes are not blindly repeated. Structured outcomes, redacted local state,
reversible setup, platform fixtures, version parity and deterministic packaging are valuable design
choices. Sources: [README](../../README.md), [architecture](../../ARCHITECTURE.md),
[authority](../../plugins/fleet/scripts/lib/authority.mjs),
[supervisor protocol](../../plugins/fleet/scripts/lib/supervisor-protocol.mjs).

The existing skill already recommends fresh verification waves and references instead of whole
transcript copying. Status already has basic filtering and result has summary support. The work here
extends these capabilities; it does not claim they were absent. Default concurrency should remain
bounded until measured. A fleet with 100 visible historical agents is not a reason to start 100 paid
turns at once.

## Findings and disposition

| Priority | Evidence and effect | Disposition |
| --- | --- | --- |
| P1 | REPRODUCED: a supervisor rooted in one workspace accepted distinct `checkoutKey` labels as distinct writer resources. Two labels could admit two writers into the same root. | IMPLEMENTED: rooted writer accounting uses the actual supervisor workspace key, not the label. Regression checks one active writer and the queued successor. This is not a complete global/worktree lease system. |
| P1 | REPRODUCED: `applyNotification` replaced the lane's current turn ID whenever a different notification turn ID arrived. A delayed prior-turn event could retarget active control. | IMPLEMENTED: reject differing active and bounded retired-turn identities; preserve the acknowledged new turn. Regression covers active-turn and continuation-dispatch cases. |
| P1 | OBSERVED: broker rejects every server-initiated JSON-RPC request with `-32601`; richer mid-turn questions/approvals do not reach a shared human/Claude inbox. | PROPOSAL: typed request bridge with exact request/turn identity, a responder lease and no automatic authority expansion. Rejection remains safer than blanket approval. |
| P1 | OBSERVED: domain validation defines a verified transition, but the production scheduler/control plane does not call that transition or expose a revision-bound verification-attestation endpoint. | PROPOSAL: evidence attached to a specific resulting tree/artifact digest, independent verifier identity and test execution provenance. Do not interpret a green UI fixture as a proof pipeline. |
| P1 | OBSERVED: local authority flags are broader than visibly enforced upstream sandbox/network mapping. A schema field does not by itself restrict every MCP/browser/database action. | PROPOSAL: capability-to-enforcement matrix and lane-local smokes. This is an enforcement-review gap, not a reproduced arbitrary-action exploit. |
| P2 | OBSERVED: static model/effort allowlist omits newer runtime models. | IMPLEMENTED: bounded `models` discovery and opt-in root `modelPolicy: runtime`, revalidated by supervisor before admission. Legacy contracts remain compatible. |
| P2 | OBSERVED: console accepts usage fields, but runtime/scheduler did not propagate reported usage into durable public records. | IMPLEMENTED: cumulative counters, replay-safe replacement and restart/late-terminal propagation. No subscription-cost estimate. |
| P2 | OBSERVED: one workspace reader and flat lane navigation make large histories hard to inspect. | IMPLEMENTED: local logical folders, six grouping modes, collapse/expand and compound literal filters. Global discovery remains a separate proposal. |
| P2 | REPRODUCED: one rejected serialized state write leaves its Promise chain rejected, preventing later writes. Unchanged reconcile passes also rewrite state. | IMPLEMENTED: later writes recover independently; unsuccessful writes remain failures; unchanged successful snapshots are skipped with pending-write tracking. |
| P2 | OBSERVED: machine status can copy full result bodies into the controller context repeatedly. | IMPLEMENTED: optional compact status, used by the bridge, retaining identity and action signals. Full result remains explicitly available. |
| P2 | OBSERVED: state is bounded to 256 lanes and 2 MiB, without a complete archive lifecycle for indefinite operation. | PROPOSAL: bounded active index plus paginated archive and visible truncation/retention notices. Do not merely raise limits. |

Relevant execution sources: [runtime adapter](../../plugins/fleet/scripts/lib/runtime-adapter.mjs),
[scheduler](../../plugins/fleet/scripts/lib/scheduler.mjs),
[broker](../../plugins/fleet/scripts/app-server-broker.mjs),
[domain](../../plugins/fleet/scripts/lib/domain.mjs),
[state](../../plugins/fleet/scripts/lib/safe-state.mjs),
[console reader](../../plugins/fleet/scripts/fleet-console.mjs),
[contract validator](../../plugins/fleet/scripts/lib/start-contract.mjs).
These links show the proposed code after merge; the revision above identifies the original evidence.

## Target architecture: observation is not ownership

The desired explorer should eventually have the following hierarchy:

```text
Workspace/project
  Physical worktree
    Run / objective
      Task folder / phase
        Fleet lane
          Observed native Codex child thread
```

**PROPOSAL:** build a read-only federated inventory from registered Fleet workspace records and the
installed runtime's official thread inventory. Codex documents `thread/list` pagination and source
filters; its default is not an inventory of every source. Explicit source-kind coverage, archive
state and partial-page indicators are required. Parent/ancestor filters that need experimental API
support must be capability-negotiated rather than assumed. [Official app-server reference][1].

Use composite identities containing workspace, admission and thread identity. A discovered thread
is **observed**, not **owned**. Reading a row must not resume, interrupt, claim or attach it. The
operator must see the source and ownership state. Any later adoption requires a live ownership
check and explicit bounded authorization. Opening another workspace must route control through
that workspace's supervisor, not reinterpret its lane ID in the current supervisor.

The current `groupPath` change provides task folders only. It does not inspect filesystem folders,
federate projects, discover native children or authorize isolated writers. Preserving that distinction
is more important than making the first screenshot look like a global control center.

## Human and Claude intervention without message races

**PROPOSAL:** a shared action inbox receives typed events such as `needs_input`, `approval_required`,
`blocked`, `outcome_unknown`, `verification_failed`, and meaningful completion. A record binds an
opaque request ID to workspace, admission, thread, expected turn, capability and expiry. The first
valid responder obtains a short lease; a compare-and-swap response prevents human and Claude from
answering the same request twice. Late answers fail visibly. Human takeover pauses automated replies.

Claude may answer a missing technical detail inside the existing objective and authority. It may not
invent user consent for deployment, payment, account access or a wider scope. The inbox must present
the exact external effect and distinguish “answer this question” from “grant this capability.”
Preserve fail-closed behavior for unknown request types. No broad replay after response timeouts.

Communication should be event-driven rather than repeated LLM polling. Maintain a local event cursor
per observing Claude session, deduplicate events and deliver a bounded delta plus references. Full
logs stay behind explicit reads. Pure dashboard navigation never causes inference.

There is a current official integration route worth testing: Claude Code documents `asyncRewake`,
which can wake an idle session when the hook exits with code 2. Ordinary async results instead wait
for the next turn. Hooks are not automatically deduplicated. Therefore a future bridge needs a
version/capability check, explicit opt-in, bounded wake count, cooldown, exact session routing and
urgent-event selection. Never turn every token/heartbeat into a wake. Use structured argument
execution, not model-generated shell interpolation. This mechanism is **not enabled in this PR**.
See the official hook fields and async limitations [2].

## Evidence that remains true after another agent writes

**PROPOSAL:** a successful worker outcome is an implementation claim. An independent reviewer should
receive the original requirement and resulting diff/artifacts, not treat the implementer's narrative
as ground truth. A verification record should bind:

- subject admission and terminal turn;
- exact base and resulting Git tree or artifact hashes;
- a distinct verifier thread and its explicit authority;
- commands/observations, exit status, environment and evidence references;
- limitations, expiry and invalidation when the subject changes.

This is not merely adding a second model. A distinct model may still share a mistaken assumption;
an independent input and reproducible check matter. Tests of mocked services do not prove production
accounts. Unit tests do not prove a browser flow. A text list named `verification` is not equivalent
to command execution evidence. Keep statuses such as `complete_unverified`, `verified_at_revision`
and `verification_stale` semantically separate, with a migration before changing existing public enums.

A dependency graph should enforce implementation -> integration -> verification waves against frozen
subjects. Parallel writers require verified physical worktrees and independent resource leases for
browser profiles, database targets, ports and deployments. The current shared-root label fix closes
one reproduced hole; it does not implement multi-resource isolation. Continuation admission and
resource reservations also need adversarial race tests, including max-active reservations across
await boundaries, before promising globally strict concurrency.

## Use less context without weakening output

**PROPOSAL:** preserve the task's goal, constraints and acceptance criteria in a compact versioned
ledger. Give workers scoped file references and small deltas, not the whole history of all workers.
Keep stable context reusable within a continuing task, but force fresh subject evidence for an
independent review. Fetch detailed artifacts only when a decision needs them. Context engineering
is about selecting useful context, not deleting necessary requirements [3].

The compact status implementation reduces serialized observations. It does not prove any fixed
percentage of subscription savings. Filtering notification text from the transport also does not
prove that the provider billed fewer tokens. Cumulative usage is telemetry, not an exact quota meter.
Track cached input separately when reported, but do not invent a price conversion.

Routing should minimize **tokens and human intervention per accepted, verified task**, subject to a
quality floor. Measure rework, missed requirements, verifier-detected failures, end-to-end latency,
controller interruptions and observed usage. Compare fixed single-worker, bounded parallel and
risk-tiered review policies on the same real task set. Use models/efforts reported by the installed
runtime; do not hardcode branding assumptions or run every trivial action at maximum effort.

Start with bounded concurrency and increase only when tasks and resources are independent. On quota
or capability failure, stop or propose an explicit alternative; do not silently change models,
accounts or browser profiles. Observability, machine-checkable boundaries and legible artifacts are
more durable improvements than adding agents [4].

## Validation and known limits

The change includes dedicated navigation and runtime-observability tests, plus existing regression
suites. New cases cover 256-record fixtures; collapse/filter counts; Unicode and narrow terminals;
headers never becoming action targets; exact model capability validation and pagination; replay-safe
usage; durable recovery; stale turn events; rooted writer serialization; and real CLI compact-status
wiring with unknown-outcome semantics. New tests use fake brokers where stated, not paid model calls.
The original stale-turn and duplicate-writer tests failed before their fixes.

Local runtime: Node **22.16.0**, below the repository's declared **>=22.20.0**. npm installation failed
because the container could not resolve the registry. Native `node-pty` was therefore unavailable.
Local non-PTY results are useful regression evidence, not a substitute for the repository's pinned
Windows/macOS/Linux Node 22/24 CI or a real Claude editor-handoff test. The final delivery records
exact test counts and CI state separately. No live model/account benchmark, capability smoke or
percentage token reduction was measured. No user credential/configuration was modified.

The existing performance guardrail's idle sample measures CPU around a sleep interval; renderer
startup is not full Claude-to-console handoff latency. Keep those synthetic guardrails, but add real
interactive workloads before making UX performance claims. Large history, notification reorder,
failed writes, orphaned locks, retry ambiguity and process shutdown should be fuzzed together.
The retired-turn set is bounded and is not a proof against arbitrary unbounded history replay.

## Reviewable next slices and exit criteria

| Slice | Deliverable | Acceptance gate |
| --- | --- | --- |
| This PR | Local navigation, model capability discovery, usage pipeline, compact status, identity/persistence fixes | Existing and added tests; pinned cross-platform CI; isolated live canary before release |
| Inventory | Registered projects, source-aware thread discovery, ownership badges, saved views and archive paging | 100+ mixed-source fixtures with duplicate IDs; no inference or mutation on observation; explicit incomplete-inventory state |
| Intervention | Typed request/reply inbox, human takeover, cursor-based Claude notifications, opt-in asyncRewake | Duplicate/stale/expired responses rejected; no unauthorized effect; one urgent event causes at most one bounded wake |
| Execution/evidence | Real worktree/resource leases, dependency graph, revision-bound verification | Concurrent continuation tests; no shared resource races; stale verification invalidated after any subject change |
| Efficiency/release | Risk-aware routing, bounded retention, quality/cost evaluation, versioned canary and compatibility matrix | Comparable tasks and measured accepted-output quality; no quota-cost invention; install/rollback and PTY matrix green |

Do not merge all future slices as one speculative rewrite. The first PR can be reviewed and rejected
independently. Keep main and the working installation unchanged until the owner reviews the diff.
A release should have its own coherent version bump and setup/runtime parity validation.

## Primary references checked on 2026-09-06

[1]: https://developers.openai.com/codex/app-server
[2]: https://code.claude.com/docs/en/hooks
[3]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[4]: https://openai.com/index/harness-engineering/

1. [Codex app-server: model/thread discovery and control protocol][1].
2. [Claude Code hooks: asyncRewake, execution fields and async limitations][2].
3. [Anthropic: effective context engineering][3].
4. [OpenAI: harness engineering][4].

Provider documents describe available primitives, not proof that this integration has implemented
or safely exercised every primitive. Repository findings above are grounded in the pinned source.
