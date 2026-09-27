# Fleet patterns

Use the smallest topology that creates material speed, breadth, or independence. Coordination is not
free: every extra lane adds context, scheduling, synthesis, environment setup, and verification cost.
The incident baseline showed that a lane can spend millions of mostly cached input tokens while making
little progress when one brief contains too many sequential deliverables.

When presenting a lane count, count every Codex lane across all sequential waves. A later integrator
or fresh verifier is still a lane even though it must not run concurrently with the writer wave.

## One lane by default

Use one lane for an atomic review, one-file diagnosis, bounded research question, or sequential change.
Do not create multiple lanes merely to make the dashboard busy.

A practical implementation lane should normally contain at most **two coherent deliverable slices and
one migration**. If the brief has four independently reviewable pieces, split them into separate lanes or
waves instead of asking one thread to repeatedly reread and self-review all four. This is a cost rule and
a reliability rule: very large threads are harder to resume, even though the P0 runtime now uses bounded
paged history.

Put stable workspace rules shared by siblings in root `sharedContext`. Keep lane `prompt` specific to the
one deliverable, inputs, exclusions, and verification plan. Do not duplicate a 6–9 KiB common brief into
every lane when the contract has a shared field for it.

## Independent read-only fan-out

Use two to four lanes when evidence surfaces are genuinely independent: code/history, security,
performance, legal/docs, or distinct source families. Give each lane a disjoint question and output
schema. Synthesize only after all terminal results arrive.

## Live research

Use one current-web researcher for a narrow question. Add a second lane only for independent source
verification or a materially different source corpus. Require dates, direct sources, and lane-local live
search smoke evidence. A fresh verifier checks the claims and source fit, not merely the prose.

If a narrow request says only to research and independently verify, use one researcher followed by one
fresh verifier: two lanes total. Do not add a second researcher unless the user or evidence plan names a
distinct source corpus that can be investigated independently.

## Shared-checkout implementation

Use exactly one writer in the shared physical workspace. Run investigators first, then the writer, then
a fresh read-only verifier in a later wave. The writer may run tests; that does not replace independent
review. Different `checkoutKey` strings inside one physical workspace do **not** create extra writer
capacity.

## Isolated writer fan-out

Use parallel writers only when changes are independent and each has a pre-created isolated worktree.
Assign distinct `checkoutKey` values. After writers finish, one integrator reviews and combines changes
in a controlled checkout. A fresh verifier runs only after integration.

A new worktree also needs its own trustworthy environment. A shared/editable Python environment may
resolve a package from a sibling worktree and create a false green. Fleet's P0 preflight blocks a local
`.venv` whose editable package roots escape the selected workspace, but it does not install application
dependencies automatically. Prepare/sync the worktree environment before dispatch when the repository
requires it, or put that prerequisite in `verificationPlan.start`.

An integrator that merges or edits is a write-capable lane and counts as a writer in fleet summaries,
even though it runs in a later wave and remains the only writer in its checkout at that time.

For lineage across worktree ledgers, use qualified `retryOf` as `<workspaceKey>:<laneId>`. The source
workspace owns its own reconciliation evidence; the qualification preserves ancestry without pretending
that two physical workspaces share one scheduler history.

## Mutable-resource operator

Assign one operator per browser profile, account, tenant, database, deployment target, sender, or payment
context. Read-only investigators may prepare evidence in parallel; only the operator touches mutable
state. State mutation needs a preview and explicit confirmation.

## Verification topology

Separate **start**, **completion**, and **controller-owned** checks. A known host-only Windows build or
real PostgreSQL integration suite should not prevent a lane from writing code when the lane can still do
safe useful work; put that check in the controller set and never call it passed. Conversely, a missing
interpreter/package that makes the implementation meaningless belongs in the start set.

A read-only verifier should not run a mutating or cache-writing test just to appear complete. Where
appropriate use `PYTHONDONTWRITEBYTECODE=1` and `pytest -p no:cacheprovider`, or give the verifier the
controller's already-produced gate evidence and ask it to inspect the artifact independently.

For visual claims, source review is not render evidence. A CSS rule can silently override correct data.
If browser/visual measurement is unavailable, mark the visual claim unverified and put the browser check
on the controller or a separately authorized QA surface.

## Adversarial review

Separate builders from reviewers. Give reviewers the requested behavior, diff/artifact, threat model,
and verification commands—but not the builder's private reasoning. Ask for evidence that can refute the
claim, not generic criticism.

Do not optimize one gate by moving behavior into another gate's blind spot. Prefer behavior tests over
regex/source-literal pins unless exact source text is the requirement. When mutation testing is used,
assert that the mutation actually changed the intended artifact before interpreting a surviving/killed
result.

## Resource controls

- Default `maxActive`: 3.
- Default writers per physical workspace: 1.
- Stagger starts; do not spike provider or host resources.
- Prefer higher effort for architecture, security, ambiguous diagnosis, and final verification.
- Prefer bounded/cheaper lanes for mechanical inventory or deterministic checks when available.
- Preserve an explicit user model/effort choice; never fabricate a model identifier.
- Stop idle or blocked lanes only when Fleet proves ownership.
- Use `result --wait` or `watch`, not shell sleep loops, for completion observation.
- Treat `queued` as a scheduling state, not proof of execution; inspect `queueBlocker` and `startedAt`.

Parallelism must fall when tasks share state, rate limits, browser sessions, scarce memory, or a single
external tenant. If decomposition creates more integration work than progress, keep it sequential.