# Fleet incident findings follow-up — 2026-09-09

This note tracks the measured 2026-09-07/08 Claude-orchestrated Fleet incidents through the two stacked hardening changes.

## Scope boundary

PR #14 owns the P0 runtime correctness fixes: bounded/paged thread history, report-only structured-result repair, zero-inference environment preflight, continuation-reservation reconciliation, queue-blocker evidence, shared stable context, truthful verification states, longer evidence retention, touched-file evidence, and fresh-vs-cached token accounting.

This follow-up owns the operator surface that makes those runtime capabilities usable without reading source code or editing Fleet state by hand. It also corrects the preflight policy where the measured Windows host can safely edit files even though a nested Node worker cannot start. It intentionally does not widen the Codex sandbox, fabricate a PostgreSQL target, vendor application fonts, or treat a missing browser as visual proof.

## Incident-to-fix matrix

| Incident class | Resolution |
|---|---|
| Invalid mutable lane report / `outcome_unknown` | PR #14 performs one same-thread report-only repair under read-only, network-off authority. PR #15 exposes evidence-backed `resolve` when reconciliation is still required. |
| Windows nested-process `EPERM` / Python worktree provenance | PR #14 measures both boundaries before useful work. PR #15 makes a nested-process denial an explicit non-blocking warning/controller-owned completion boundary so safe file implementation can continue, while editable Python provenance that resolves outside the selected worktree remains a hard pre-turn block because it can create a false green against another checkout. Host policy is not weakened. |
| Four-slice mega lanes and repeated stable context | PR #14 adds root `sharedContext`; orchestration guidance now keeps one lane to at most two coherent deliverable slices and one migration. |
| Two-step cancellation / no terminal cleanup | PR #15 adds `fleet cancel <laneId>` as an identity-bound preview+confirm shortcut and exposes `archive`. Touched files are returned. |
| `modelPolicy` placement / stale model catalogue | PR #14 improves validation and catalog age/refresh support; PR #15 exposes `models --refresh`. |
| Wrong `--workspace` ledger | PR #15 reports registered sibling worktree ledgers when the selected workspace is empty instead of implying global absence. |
| Completion checks interpreted as start gates | PR #14 adds `verificationPlan.start`, `.completion`, and `.controller`; guidance requires using the split. |
| No completion notification / polling loops | PR #14 adds scheduler wait/event primitives; PR #15 exposes `result --wait` with a default timeout and `watch` long-polling. |
| Windows `/tmp` mutation false green | PR #14 execution posture requires workspace scratch and proof that the mutation actually applied. |
| Queue says `queued` but cannot start | PR #14 emits `queueBlocker`; PR #15 reads the live existing supervisor snapshot and renders the blocker without starting a new supervisor. |
| Worktree `uv run` measures sibling source | PR #14 blocks local `.venv` provenance that resolves editable packages outside the selected workspace. |
| Gate blind spots / source-pinning / unverified visual claim | PR #14 distinguishes verification statuses, requires behavioral evidence, rejects blind-spot gate workarounds, and requires browser/visual evidence for visual claims. |
| 512-character result evidence truncation | PR #14 raises result/evidence retention bounds and keeps structured verification results. |
| Plugin/runtime version path mismatch | PR #15's CLI entrypoint resolves the ownership-manifest integration runtime for control commands when installed-plugin and applied-runtime versions differ; setup/uninstall/doctor/help stay on the installed plugin surface. |
| Follow-up syntax undiscoverable / no help | PR #15 adds root and command help including the exact follow-up JSON shape. |
| PostgreSQL tests deselected | Not fabricated. Use `verificationResults` with `skipped`/`blocked` and controller-owned verification until a real target exists. |
| 1 MiB thread resume failure | PR #14 resumes metadata-only, reads bounded paged history, and raises/configures the broker secondary frame budget. |
| Ambiguous follow-up permanently holds writer lock | PR #14 probes reservations and can prove not-started/started/terminal. PR #15 exposes `reconcile`; manual assume-not-started requires evidence. |
| Cross-worktree `retryOf` loses lineage | PR #14 accepts qualified `<workspaceKey>:<laneId>` lineage. |
| `outcome_unknown` cannot be resumed | Preserved fail-closed. First use report repair; then `resolve` with reconciliation evidence. Do not make uncertain mutable work directly resumable. |

## Deliberately not treated as Fleet runtime bugs

The incident notes also contained valid project- or brief-owned failures: an application using remote Google Fonts in an offline build, no real PostgreSQL test target, contradictory zero-customer-query arithmetic, and a home-page extraction fallback whose specification was wrong. Fleet should make those limitations visible and cheap; it should not silently change product requirements, network authority, or test infrastructure.

Likewise, a sandbox that cannot spawn the application's required nested worker is not made "green" by weakening Fleet's authority boundary. Fleet records the denial and tells the lane that the affected completion check is controller-owned. The lane may still perform safe implementation that does not depend on that child process and may not report the blocked check as passed. A Python environment that would test a sibling worktree is different: that is a false-evidence hazard, so Fleet refuses to start the model turn until provenance is trustworthy.

## Operator commands after both PRs

```text
fleet --help
fleet models --refresh --workspace <worktree> --json
fleet status --workspace <worktree>
fleet result --lane <id> --wait --summary
fleet watch --workspace <worktree>
fleet cancel <id> --workspace <worktree>
fleet reconcile <id> --workspace <worktree>
fleet reconcile <id> --assume-not-started --evidence <ref> --workspace <worktree>
fleet resolve <id> --evidence <ref> --outcome complete --workspace <worktree>
fleet archive <id> --workspace <worktree>
```

These are control-plane operations. They do not create additional model turns except where the underlying requested lane operation itself requires one.
