# Research-to-implementation review: evidence-bound Fleet control

**Baseline:** PR #18, `b3d0a32d34e16a06498243f4d54b46a2bbf42dce`.
**Review date:** 15 September 2026. **Scope:** a complete additive machine-control,
source-evidence and prepared-wave implementation. No release, installed-runtime
upgrade, native adoption, authenticated model workload, or world-ranking claim.

## Decision

Optimize accepted, evidence-supported work per unit of coordination, not the number
of agent processes. The delivered loop is: discover a small interface; observe only
meaningful state; choose a capacity/budget-bounded ready frontier; bind execution
identity; verify the resulting source with a fresh verifier; revalidate the receipt.
Legacy Fleet safety remains the execution authority. The new surface is not a bypass.

The previous local control prototype exposed operations whose services were missing.
This implementation wires all fifteen advertised operations into the real supervisor.
It also fixes previously missing cancellation target fields, adds pinned continuation
revisions, prevents mixed-source verification, and tests full CLI/IPC/broker paths.
The design deliberately avoids a speculative rewrite of the proven runtime adapter.

## Primary-source research and adopted mechanisms

### Agent-computer interface, not just prompts

[SWE-agent](https://arxiv.org/abs/2405.15793) evaluates how an agent-specific interface
changes software-engineering behavior. Its benchmark results belong to its evaluated
models and environment, not Fleet. The transferable design principle is making valid
operations easy to discover and invalid operations explicit. Fleet now has a small
operation index, on-demand nested schemas, examples, validated envelopes, and precise
retry categories. The schema is useful but does not itself prove runtime authority.

[Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
describes lazy tool discovery and programmatic execution that keeps intermediate
results outside model context. Fleet implements that pattern locally: the Node client
assembles pages and result fragments before the controller chooses what to print.
No Anthropic beta API integration or the article's percentage savings is claimed.

[Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
emphasizes selecting relevant information rather than maximizing history length.
Fleet retains exact machine identity and evidence references while withholding full
work bodies until requested. The delta feed avoids repeated unchanged records and
ignores timestamp-only churn; reported usage is opt-in. We do not compress away
uncertainty, missing gates, or outstanding approvals to get a smaller response.

### Coordination is workload-dependent

[Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3)
compares coordination structures under controlled budgets and finds strongly
task-dependent benefits and harms. We therefore keep one worker as the guidance
baseline, add parallelism only to ready independent work, and preserve an explicit
FIFO comparator. Its model-dependent coefficients and task scores are not tuning
constants for this repository; the task corpus and runtime differ.

[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/html/2503.13657v2) distinguishes
specification, coordination and verification failures. A stronger model alone does
not replace these system checks. Fleet's graph validation prevents cyclic/ambiguous
dependencies; attempt identity prevents stale continuation; source receipts prevent
historical verdicts being accepted for changed code. These controls address specific
failure classes, not all failures in the paper's taxonomy.

### Long-running work needs explicit handoff and evaluation

[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
and [harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
use structured task state and separate evaluation to improve extended workflows.
Fleet's receipt and result metadata can be re-read after restart, while ephemeral
plans explicitly cannot. Bound verifiers cannot inherit mutable authority or accept
new steering instructions. This is a controlled evaluation boundary, not a claim that
adding a verifier universally improves subjective design or benchmark accuracy.

[OpenAI harness engineering](https://openai.com/index/harness-engineering/) treats the
repository and verification environment as part of the agent's effective system.
The added AGENTS map, reusable control skill, real operation schemas and regression
suite make these expectations executable and discoverable. We did not duplicate the
entire repository's operating manuals in every worker prompt.

[Anthropic's evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
separates the transcript's claims from the actual environment outcome. Accordingly,
Fleet does not count a reported success as a measured accepted application change.
Current tests demonstrate protocol/runtime invariants with fixtures. Actual model
quality, acceptance, browser correctness and cost per accepted change require the
separate workload evaluation described below.

### Identity, content binding and uncertainty

[AWS idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
explains why replay identity and uncertainty matter. Fleet scopes replay to one live
prepared-plan token and stores its promise before crossing an asynchronous boundary.
It does not reconstruct a lost plan after restart or treat a requestId as an exactly-once
execution guarantee. Partial admission returns reconciliation requirements and cannot
be silently repeated from the same token.

[SLSA's attestation model](https://slsa.dev/spec/v1.2/attestation-model) separates artifact
subjects, statements and authentication. Fleet borrows content binding, **not a SLSA
conformance label**. Its local receipts bind a worker, verifier, source and evidence
files. They are not signed execution provenance; the user controls the local account
and the ledger. A matching content hash proves neither test adequacy nor honest
execution. Responses name the claim `source-bound-reported-verification` and keep
`releaseAuthorized:false`.

[Codex App Server](https://developers.openai.com/codex/app-server/) and OpenAI's
[Codex harness integration article](https://openai.com/index/unlocking-the-codex-harness/)
support a structured runtime integration rather than uncontrolled shell-driven model
launches. Fleet keeps its existing broker/adapter and adds a machine surface over the
supervisor. Actual integration tests traverse separate CLI processes, authenticated
workspace IPC and a JSONL fake Codex process; they never impersonate a real account.

[Claude skills](https://code.claude.com/docs/en/skills) and
[Codex skills](https://learn.chatgpt.com/docs/build-skills) support progressive instruction
loading. The packaged Claude skill and repo-scoped `.agents/skills/fleet-control`
instructions use the same workflow, without automatic user-global installation.
[MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
are not treated as authorization. This PR supplies JSON CLI/Node interoperability,
not an unreviewed new MCP/HTTP server or a second remote security perimeter.

## Delivered control loop

**Discovery and transport.** Fifteen versioned operations, shared structural contract
vocabulary, existing semantic admission checks, bounded UTF-8/depth/size, matching
request/reply identity and safe errors. Malformed replies cannot be used as mutation
results. CLI child cleanup does not kill arbitrary processes or claim a detached task
was cancelled. Newly added runtime files ship with the installable plugin.

**Observation.** Bounded frozen batches, cursor/workspace/projection/epoch binding,
HMAC-protected page positions, and atomic client assembly. Unchanged observations
are small; status/requests/uncertainty remain meaningful. A shared waiter closes the
observe-to-wait race while preserving independent deadlines under a hung local read.
Force shutdown closes observation waits before draining boundary requests. Hidden
archived uncertainty remains actionable through bounded IDs and counters.

**Targeted results.** Full legacy result compatibility plus identity and revision-bound
work/check/artifact/evidence/event sections. Oversized strings fragment without losing
Unicode; changing a result rejects continuation pages rather than mixing attempts.
The Node client assembles text or JSON sections in code, under a 2 MiB ceiling.

**Execution identity.** Immutable admission-contract digest, incrementing steering/
continuation revision and a chained instruction digest survive scheduler recovery.
Continuation requires matching thread, turn and revision. Cancellation requires all
preview identity fields and the existing token. A role or plan is not permission.

**Source-bound reports.** Quiet-source transaction, source hashing, completed-worker
binding, fresh checkpoint-specific verifier admission guard, writer/verifier exclusion,
required passed reports, exact evidence-reference matching and private receipt storage.
Receipt check detects changed source, attempts or evidence, including after restart.
Legacy records without provenance cannot manufacture a new verified receipt.

**Prepared execution.** DAG validation, current external dependency receipts, critical
path/age ordering, FIFO comparator, capacity accounting for queued/running/reserved
work, estimated token reserve and one mutable candidate per prepared wave. Apply
rechecks state after catalogue initialization, enters the existing scheduler and caches
its admission promise. Source changes, stale plans and unknown dispatch never trigger
an automatic second attempt. No model routing aliases or higher effort are invented.

## Evidence-Bounded Frontier v1: algorithm and tradeoffs

For candidate i, define its downstream rank as estimated duration d(i) plus the largest
rank of an internal successor, or d(i) for a leaf. A depth-first memoized traversal
detects cycles. Readiness requires that no internal predecessor is outstanding and
all external predecessor receipts are current for their corresponding worker/source.

Eligible candidates are sorted lexicographically by bounded wait-age tier (descending),
downstream rank (descending), estimated token demand (ascending), then input order.
Age has one-minute tiers capped at 32; it favors older eligible candidates over
new arrivals but is not a formal fairness guarantee once multiple candidates saturate
the age cap. It cannot ensure progress for an impossible budget or blocked dependency. Choose candidates
while both capacity and the estimated budget minus verification reserve allow them.
Mutable work is isolated rather than packed with readers in a prepared wave.

This is a practical composition of list-scheduling and admission controls, not an
original optimality theorem. Estimates can be wrong. With two workers and independent
durations [3,3,2,2,2], longest-first ordering can take 7 units while a different packing
takes 6; adding precedence and uncertainty makes the general problem harder. The
implementation chooses a bounded next wave, not a globally optimized complete schedule.
We preserve FIFO so workload-level comparisons can reveal regressions instead of
burying them beneath an appealing algorithm name.

The source guard and whole-tree receipts intentionally trade availability for safety.
An unrelated file change can invalidate prior dependency evidence. A large repository
can hit the explicit capture budget. Multiple real worktrees are still separate
supervisor scopes; the new planner is not a distributed lock manager. Extending it
requires canonical resource identities and OS/runtime fencing, not checkout labels.

## Test evidence and reproducible performance

The baseline #18 was previously cross-platform green. The final local
combined repository suite passed on Linux x64 / Node 22.23.1 with **599 tests:
598 passed, one platform-specific skip, zero failures** (67 tests added over #18).
Inspect the PR's **exact final-head** CI for supported-platform outcomes; local test
evidence is not an authenticated live-account canary or a cross-platform claim.

Negative tests cover invalid/deep/oversized envelopes, stale/mixed pages, interrupted
waits, read coalescing, disposal, changed source/index/untracked files, unsupported
links, tampered ledgers, missing/skipped/conflicting checks, verifier binding, archived
unknown writers, guard reservation races, stale continuation, plan reuse, expiry and
post-admission uncertainty. Real separate-process tests prove schema discovery starts
no supervisor, observation starts no Codex process, same-thread continuation preserves
identity, same-token replay creates one fake worker, exact cancellation works, and
hour-long waits do not trap shutdown. These are actual execution tests with explicitly
fake model servers, not authenticated real-model or human-approval evidence.

Run `npm run check:control-performance`. The committed
[synthetic sample](evidence/control-performance-20260915.json) captures Linux x64,
Node 22.23.1, ten warmups and 100 samples. Measurements are in-process serialized
payload bytes and local observation latency; CLI startup/network/model latency is
excluded. The comparator is a full retained synthetic snapshot, not subscription
usage and not the already-compact legacy summary mode.

| Fixture | Full retained JSON | Initial projection | Unchanged delta | Five changed records |
| --- | ---: | ---: | ---: | ---: |
| 100 lanes | 209,259 B | 42,401 B | 689 B | 2,644 B |
| 256 lanes | 536,001 B | 108,147 B | 691 B | 2,646 B |

The sample's warm unchanged-observation p95 was approximately 3.9 ms / 9.6 ms, with
roughly 76 / 188 KiB bounded retained cache. Timing is host-sensitive; re-run rather
than promise these latencies elsewhere. The unchanged-response byte reduction against
that full fixture is 99.67% / 99.87%, **not a token, dollar or subscription saving**.
The discovery index was 1,427 B. The constructed scheduling fixture selects its long
critical root before independent short roots; it is not a universal speedup benchmark.

CI enforces conservative budgets, not those particular timing samples: unchanged
payload <=1 KiB, changed payload smaller than initial projection, retained cache
<=2 MiB, and local warm p95 <=1 second on hosted platforms. Existing 4 Hz redraw,
CPU/heap/startup, secret/license/docs, actual PTY and runtime-race gates remain in place.
No baseline tests are removed to make the new work pass.

## Acceptance evaluation before a comparative quality claim

A meaningful next evaluation uses the same application tasks, exact initial commits,
model catalogue, environment, capability access and total allowed spend for every
variant: direct single-agent workflow; prior Fleet; new Fleet with FIFO; new Fleet
with Evidence-Bounded Frontier. Include a sequential bugfix, independent read-only
research, API/UI integration, migration with real database evidence, recovery after
accepted-response loss, and repeated long-context continuation.

Record task acceptance against held-out or independently reviewed checks, regressions,
required human interventions, wall time, provider-reported input/output/cache counters,
continuation/repair count and source-verification invalidations. Monetary cost requires
actual billing data; subscription quota must not be derived from token counts. Repeat
trials and report dispersion and failures, not only the best run. Verify artifacts and
host/browser/database state, not just successful narrative text or return code.

A model/effort escalation policy can be evaluated after this paired data exists. Do not
bake in “cheaper is sufficient” or “always strongest” before accepted-quality evidence.
Likewise, a learned scheduler would need logged propensities/counterfactual evaluation;
calling the present heuristic learned or scientifically novel would be misleading.

## Explicit non-claims and rollout boundaries

No global first-place/percentile claim, authenticated SWE-bench result, universal
throughput gain, measured model-token saving, signed test-execution provenance, remote
multi-tenant security, global cross-worktree fencing, native ownership adoption or
automatic deployment is established by this change. Those are distinct engineering
and evaluation problems, not capabilities quietly implied by a green test count.

The shipped behavior is complete for its declared API: no advertised service stubs.
After stacked PR review and exact-head CI, use a disposable installed profile and
explicit account consent for a live canary. Exercise observe/wait/result, prepared
read-only waves, same-thread continuation, stale rejection, checkpoint verification,
changed-source invalidation, cancellation and supervisor restart. Confirm the loaded
runtime matches the candidate before comparing visuals or behavior. Source editing
alone does not install it. No merge or release is performed by this review.
