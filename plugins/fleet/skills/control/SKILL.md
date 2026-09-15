---
name: control
description: Manage Fleet through its versioned JSON control plane: discover schemas, observe changes, wait, plan bounded tasks, and check source-bound verification receipts. Use for Fleet coordination, not direct Codex launches, user approvals, setup, or deployment.
---

# Fleet machine control

Use the trusted installed plugin entrypoint `${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs`.
For a source checkout, use its absolute `plugins/fleet/scripts/fleet.mjs` path.
The controller owns planning; workers remain bounded. Prefer one worker unless inputs
and evidence are genuinely independent. Do not recursively launch fleets from workers.

1. Run `node <entrypoint> control describe --json`; load just the operation needed
   with `control describe <operation> --json`. This is local schema discovery.
2. Send a single JSON envelope through exact argv `control --stdin --json`:
   `schemaVersion:1`, unique `requestId`, canonical absolute `workspacePath`,
   `operation`, and `params`. Never interpolate prompts into shell commands.
3. `observe` returns bounded state pages. Keep the old view until every page arrives;
   only the final page supplies the next cursor. Use the Node client in
   `scripts/lib/control-client.mjs` for atomic assembly outside model context.
4. `wait` with that cursor closes the observe/wait gap. It shares bounded local
   snapshot reads, not model calls. Timeout is not task failure. On reset, discard
   partial pages and re-observe. Do not create shell sleep/status loops.
5. Read `result` with `section:identity`, then only needed `work`, `checks`,
   `artifacts`, `evidence`, or `events`. Follow the returned `next` unchanged;
   changed revisions require restarting that section. Use `client.readSection(laneId, "checks")`
   to assemble selected results in code. Never paste all results.
6. For new work, use `prepare` with an immutable start contract, dependency graph,
   duration/token estimates and an explicit verification reserve. Inspect selected
   and deferred IDs, then `apply` its exact planToken. A live token joins the same
   admission on replay; expired/restarted or acceptance-unknown work requires
   observing candidate IDs and reconciliation, not another blind submission.
7. Use `models` for exact model/effort values and root `modelPolicy:runtime`.
   This may initialize the local Codex app-server but does not run inference.
8. For same-thread continuation, pin the latest result's threadId, turnId and
   executionRevision. A fresh requestId is not an idempotency key for model turns.
   `cancel.preview` returns expectedThreadId/expectedTurnId and confirmationToken;
   use exactly those fields in `cancel.apply` only after the operator decision.
9. After implementation/integration, use `checkpoint` with requiredChecks. Start a
   **new**, network-off, read-only `independent-verifier` with its returned
   verifierBinding. Do not run checkpoint verification alongside a workspace writer.
   Require exact passed check names and their actual evidence-file paths. `attest`
   binds those files; `check` revalidates the receipt against the current source.
10. Report facts, worker claims and source-bound reported verification separately.
    Receipts do not execute tests, grant release permission, prove visual quality,
    include ignored dependencies, or authenticate a hostile same-user verifier.

Existing sandbox, confirmation, unknown-effect and human-inbox boundaries apply.
Never invent confirmationRef, answer an approval, widen capability, label skipped
checks passed, or change account/installation settings to make a gate green.
Archiving does not resolve uncertainty: inspect `totals.archivedAttentionIds` and
use the existing `fleet reconcile` command with the exact lane/workspace and required
evidence when hidden work needs review. A timeout never proves non-execution.
A `verified` row alone is not a current-source receipt. Model usage is reported
telemetry, not subscription quota or dollar cost. Estimates reserve planning room,
not a hard provider billing cap. No topology/model is universally optimal.

For exact replay, recovery, source scope and integration examples, read
[workflow.md](references/workflow.md). Do not auto-install or write user-global config.
