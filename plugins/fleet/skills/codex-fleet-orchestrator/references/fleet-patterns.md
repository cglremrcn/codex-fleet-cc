# Fleet patterns

Use the smallest topology that creates material speed, breadth, or independence. Coordination is not
free: every extra lane adds context, scheduling, synthesis, and verification cost.

When presenting a lane count, count every Codex lane across all sequential waves. A later integrator
or fresh verifier is still a lane even though it must not run concurrently with the writer wave.

## One lane by default

Use one lane for an atomic review, one-file diagnosis, bounded research question, or sequential change.
Do not create multiple lanes merely to make the dashboard busy.

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

Use exactly one writer in the shared checkout. Run investigators first, then the writer, then a fresh
read-only verifier in a later wave. The writer may run tests; that does not replace independent review.

## Isolated writer fan-out

Use parallel writers only when changes are independent and each has a pre-created isolated worktree.
Assign distinct `checkoutKey` values. After writers finish, one integrator reviews and combines changes
in a controlled checkout. A fresh verifier runs only after integration.

An integrator that merges or edits is a write-capable lane and counts as a writer in fleet summaries,
even though it runs in a later wave and remains the only writer in its checkout at that time.

## Mutable-resource operator

Assign one operator per browser profile, account, tenant, database, deployment target, sender, or payment
context. Read-only investigators may prepare evidence in parallel; only the operator touches mutable
state. State mutation needs a preview and explicit confirmation.

## Adversarial review

Separate builders from reviewers. Give reviewers the requested behavior, diff/artifact, threat model,
and verification commands—but not the builder's private reasoning. Ask for evidence that can refute the
claim, not generic criticism.

## Resource controls

- Default `maxActive`: 3.
- Default writers per checkout: 1.
- Stagger starts; do not spike provider or host resources.
- Prefer higher effort for architecture, security, ambiguous diagnosis, and final verification.
- Prefer bounded/cheaper lanes for mechanical inventory or deterministic checks when available.
- Preserve an explicit user model/effort choice; never fabricate a model identifier.
- Stop idle or blocked lanes only when Fleet proves ownership.

Parallelism must fall when tasks share state, rate limits, browser sessions, scarce memory, or a single
external tenant. If decomposition creates more integration work than progress, keep it sequential.
