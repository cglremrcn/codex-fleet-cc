# Machine workflow and evidence limits

## Transport

The shipped dependency-free Node client is `scripts/lib/control-client.mjs` relative
to the plugin root. Import `createFleetControlClient`, supplying an absolute trusted
`scriptPath` and the canonical `workspacePath`. It spawns only Node plus the Fleet
entrypoint, with separate argv and JSON stdin. Its concurrent CLI budget defaults to
four. Keep one shared observer and at most one long wait per controller.

`client.observe(previous, {maxBytes:8192})` assembles all pages before replacing the
previous view. `client.wait(previous.cursor)` returns a reason; then observe again.
`client.call("result", {laneId, section:"identity"})` retrieves execution identity.
`client.readSection(laneId,"checks")` assembles a bounded section outside the model's
context. Only print relevant conclusions and missing/failed checks, not every item.
The client is bounded to 2 MiB per assembled section; larger sections can be consumed
as individual pages without pretending they were fully reviewed.

All envelopes contain `schemaVersion`, `requestId`, `operation` and `ok`. `ok:false`
is an error even if a host ignores the CLI exit status. The error's retry field is
`safe`, `same-plan-only`, or `reconcile-first`; it is guidance, never authority.
`requestId` correlates replies; it does NOT deduplicate `start` or `continue`.

## Checkpoint, verifier and receipt

Use `checkpoint({laneId,requiredChecks:["unit"]})` only after completed work is quiet.
The returned `verifierBinding` contains `verificationCheckpoint` and an exact
`verificationPlan.completion`. Add these fields to a fresh independent-verifier
contract, preserving its separately chosen exact model/effort and non-interactive,
read-only/network-off authority. A changed source refuses the verifier before its
model turn starts. Do not put implementation reasoning into its brief.

The verifier must report a structured passed check whose `evidence` equals the
workspace-relative file it actually inspected, for example `evidence/unit.json`.
Use `attest({checkpointId,verifierLaneId,evidenceFiles:[{check:"unit",path:"evidence/unit.json"}]})`.
Then `check({receiptId})` must say `current:true`; legacy status labels are not enough.
A receipt can be rediscovered from a targeted result's `sourceEvidence` metadata,
but metadata alone is unchecked. Run `check` before relying on it.

This is source-bound REPORTED verification, not a trusted command-execution receipt.
The controller may run authorized host-only tests and supply their real logs before
a read-only verifier inspects them. Do not pretend the verifier created or executed
a log it only read. Preserve failed/skipped/blocked tests. Browser, database, network,
and dependency/environment assertions need their own actual evidence.

Source includes Git HEAD/index, actual tracked working bytes, deleted tracked files
and nonignored untracked files. Ignored files are excluded from the source snapshot;
the named evidence files are independently hashed. Symlinks, hardlinks, submodules,
unmerged entries and over-budget trees are refused, not silently accepted. The
cooperative Fleet scheduler pauses admissions for capture and separates bound
verifiers from mutable work. It is NOT an operating-system snapshot or a global
cross-harness lock; other writers must use isolated physical worktrees or coordinate.

## Prepared waves

Each candidate contract lane has exactly one graph node with matching id and positive
estimatedTokens/estimatedMs. Internal candidate dependencies remain deferred until
the prerequisite is completed and verified. In a subsequent preparation, remove
already-admitted candidates and refer to prerequisites with `{laneId,receiptId}`.
The receipt must be current for the same source and worker. This is conservative:
whole-tree changes invalidate old dependency receipts. Integrate then verify a wave;
do not claim unrelated-file independence the system has not proven.

The ready wave respects active/queued/reserved capacity and the estimated budget minus
verification reserve. The critical-path heuristic has age tiers and FIFO comparison;
no optimality claim. A mutable candidate runs alone within this prepared wave.
Prepared plans are RAM-only, bounded, and expire after two minutes. They do not create
worktrees, adopt native sessions, choose a new model, or grant additional authority.

Before apply, Fleet checks current source, lane identity, receipt validity and capacity,
including after runtime model discovery. Concurrent same-token apply calls join one
promise. Partial/unknown admission never triggers a second admission from that token.
After supervisor restart, no lost token is reconstructed. Read every candidate ID;
resolve unknown effects through the existing recovery commands before new work.
