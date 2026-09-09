# Fleet operator recovery

Use these commands for measured runtime incidents after the P0 hardening change. They operate on the selected physical workspace/worktree ledger; `checkoutKey` is not a substitute for a separate worktree.

## Observe without polling

`fleet result --lane <id> --wait --summary` waits up to ten minutes by default. It uses the Fleet supervisor waiter, not a shell `sleep` loop. A timeout means the lane is still non-terminal; it is not reported as a failure.

`fleet watch --workspace <path>` long-polls for terminal transitions, controller attention, intervention requests, a queued lane that has stalled, or an ambiguous continuation reservation. It starts no model turn by itself.

Normal `status` hides archived lanes. Use `--archived` for only archived records or `--include-archived` for both. When a live supervisor exists, status reads its snapshot so `queueBlocker` explains the active writer, continuation reservation, capacity, or scheduler ordering that is holding a lane. When the selected workspace has no lanes but registered sibling worktrees have ledgers for the same Git repository, status points to those ledgers instead of saying that Fleet globally has no work.

## Reconcile before retry

A mutable `outcome_unknown` is intentionally not directly resumable. First rely on Fleet's one report-only repair turn. If the result remains unknown, reconcile the effects and record evidence:

```text
fleet resolve <laneId> --evidence <ref> --outcome complete --workspace <path>
```

For a follow-up whose request acceptance is ambiguous, use:

```text
fleet reconcile <laneId> --workspace <path>
```

Fleet probes Codex thread history. If it proves no new turn started, the writer reservation is released. If it proves a turn started, the reservation remains or the terminal work becomes `outcome_unknown`. Only when independent operator evidence proves the turn never started may you use:

```text
fleet reconcile <laneId> --assume-not-started --evidence <ref> --workspace <path>
```

Never use `--assume-not-started` merely because the control request timed out.

## Cancel and archive

`fleet cancel <laneId> --workspace <path>` is the high-level cancellation command. Fleet performs the preview and identity-bound confirmation internally; if the target thread/turn changes between those steps, the confirmation digest no longer matches and cancellation is refused. Review the returned `touchedFiles` before reverting or discarding anything.

After terminal work no longer belongs in the normal operator view:

```text
fleet archive <laneId> --workspace <path>
```

Archive changes only Fleet's local ledger visibility. It does not delete workspace files or remote effects.

## Model catalogue and runtime version

For newly available Codex models, use:

```text
fleet models --refresh --workspace <path> --json
```

Refresh is allowed only while the Fleet runtime is idle. Runtime contracts put `modelPolicy: "runtime"` at the root, never inside a lane.

Fleet's top-level CLI entrypoint resolves ordinary control commands through the ownership-manifest integration runtime when the applied runtime version differs from the installed plugin version. This prevents an older installed plugin copy from silently validating a newer integration-runtime contract with an older schema. Same-version control stays on the current installed copy; setup, uninstall, doctor, and help also stay there because those surfaces own or diagnose the version transition itself.

## Verification boundaries

Fleet distinguishes an environment limitation from a false-evidence hazard. A nested-process preflight such as Windows Node `spawn EPERM` is recorded as a non-blocking warning and injected into the lane as a controller-owned verification boundary. Safe file implementation may continue, but the lane must not claim the blocked build/worker check passed or burn repeated turns retrying it.

Python worktree provenance is stricter. If a worktree-local `.venv` resolves an editable package outside the selected workspace, Fleet blocks before the model turn because tests could otherwise pass against a sibling checkout. A missing local `.venv` remains explicitly unproven rather than silently borrowing a shared environment.

Fleet cannot fabricate a PostgreSQL server, browser, external font cache, or other project prerequisite. Represent controller-owned or unavailable checks explicitly in `verificationPlan` and the returned `verificationResults`; `skipped` or `blocked` is not `passed`. For a read-only Python verifier that should not write pytest caches, prefer `PYTHONDONTWRITEBYTECODE=1` and `pytest -p no:cacheprovider` when those flags are applicable to that repository.
