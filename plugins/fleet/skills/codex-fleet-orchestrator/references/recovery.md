# Recovery

Recovery preserves evidence and prevents duplicate or unauthorized effects. It never guesses that a timeout means failure. **Never blind retry** an unknown outcome. After a post-send timeout, **do not redispatch** until request acceptance and prior effects are reconciled.

## Observe before acting

Use Fleet's event-backed controls instead of shell polling loops:

```text
fleet result --lane <id> --wait --summary
fleet watch --workspace <workspace>
```

`result --wait` defaults to ten minutes. A wait timeout is not a lane failure; inspect the returned live state. `watch` returns on terminal transitions, controller attention, intervention, queue stall, or an ambiguous continuation. A `queued` label is not proof that execution started: inspect `startedAt`, `turnId`, and `queueBlocker`.

Normal `status` hides archived lanes. Use `--archived` for old terminal records. If the selected workspace ledger is empty but `workspaceRouting.relatedWorktrees` is returned, switch to the intended physical worktree instead of concluding that Fleet has no lanes.

## OUTCOME_UNKNOWN

When a mutable lane may have effects but no trustworthy structured terminal result exists:

1. freeze automatic retry and dependent mutation;
2. preserve the lane/thread/turn identity, touched files, request timestamp, and last acknowledged phase;
3. if Fleet is performing its one report-only repair turn, let that same thread return a corrected report;
4. otherwise inspect the produced artifact and authoritative target using read-only/controller authority;
5. attach reconciliation evidence;
6. record the reconciled terminal state when it is actually proven;
7. only then continue or retry.

The report-only repair is deliberately narrow: read-only, network-off, no implementation, no new mutation, no browsing, no widened authority. A second malformed report remains `outcome_unknown`.

Do not make an unknown mutable lane directly resumable merely because the schema error looked small. The code may already be on disk, an external effect may have happened, or a timed-out request may have started a new turn. “No local response” is not proof of absence.

After evidence proves the terminal result, record it explicitly:

```text
fleet resolve <laneId> --evidence <ref> --outcome complete --workspace <workspace>
```

Use `failed` or `cancelled` only when the evidence supports that outcome. `resolve` records reconciliation; it does not manufacture independent verification.

## Ambiguous continuation / writer reservation

A follow-up request that times out after send can retain the physical workspace writer reservation until Fleet can prove what Codex did. First probe:

```text
fleet reconcile <laneId> --workspace <workspace>
```

Fleet checks bounded thread metadata/history. Proven not-started reservations are released. Proven started work stays bound to its real turn; a terminal started turn becomes `outcome_unknown` for artifact/effect reconciliation. An ambiguous result keeps the reservation.

Only when independent evidence proves that no turn started may the operator override the ambiguity:

```text
fleet reconcile <laneId> --assume-not-started --evidence <ref> --workspace <workspace>
```

Never use `--assume-not-started` simply because `active:0`, the runtime is `ready`, or the control request timed out. A ledger reservation can legitimately hold writer capacity while no live process is active.

## Cancellation

For an explicitly confirmed cancellation, prefer:

```text
fleet cancel <laneId> --workspace <workspace> --json
```

The high-level CLI performs protocol preview + confirmation internally. The digest is bound to the current lane/thread/turn, so an identity change causes refusal instead of cancelling a new turn accidentally. Review returned `touchedFiles` before any cleanup or revert; cancellation does not mean the lane wrote nothing.

## Broker or process interruption

Read stored lane/thread state before starting anything. Reconnect to an existing owned thread when the runtime proves identity. Stop only an **owned process** whose recorded identifier and start identity match; never kill by broad name, port, glob, or unrelated PID. If ownership is uncertain, leave it running and report the ambiguity.

Persisted `queued`, `starting`, or `running` work found after supervisor loss becomes `interrupted`, not failed. Preserve its thread and evidence. An interrupted lane requires controller **reconciliation** before any retry; workspace dirtiness is only a workspace-level observation and is not attributed to that lane.

Large persisted threads are resumed metadata-only and recent turns are read through bounded paging. An oversized secondary JSONL frame is a protocol boundary, not permission to hydrate the full transcript or blindly retry. Keep new lanes bounded even though the runtime is more resilient.

## Capability or environment denial

Keep completed evidence, mark the denied surface, and state the smallest explicit fallback. Do not widen sandbox/network/browser/database/external-effect authority, change account, or silently move the work to Claude. A new route requires the user authority appropriate to that route.

P0 environment preflight intentionally happens before a model turn for workspace writers. It can detect that a nested process cannot spawn or that a worktree-local editable Python package resolves outside the selected workspace. It does not install dependencies, provide a PostgreSQL server, cache remote fonts, or create browser access. Those project prerequisites remain `blocked`, `skipped`, or controller-owned checks; they are never reported green by inference.

## Model catalogue and runtime-version drift

When a requested model is absent or the catalogue may be stale, use:

```text
fleet models --refresh --workspace <workspace> --json
```

Refresh is safe only while the Fleet runtime is idle. Put `modelPolicy:"runtime"` at the root of a start contract. Fleet's top-level entrypoint resolves ordinary control commands through the applied ownership-manifest integration runtime so an installed plugin copy does not validate a newer runtime contract with an older schema. `setup` and `uninstall` stay on the installed plugin surface because they own that version transition.

## State cleanup and archive

Cleanup applies only to resources the lane or Fleet can prove it owns: its temporary files, isolated worktree, socket/pipe, or exact process. Preserve modified or user-owned files. Record retained resources and why they were not removed.

When terminal evidence no longer belongs in the normal operator view:

```text
fleet archive <laneId> --workspace <workspace>
```

Archive changes only Fleet ledger visibility; it does not delete files, processes, or external effects.

## Resume criteria

Resume only when authority remains valid, capability smoke is current, workspace/account identity still matches, prior effects are reconciled, and the original contract still describes the requested outcome. Otherwise create a new preview and contract. For a retry moved to another physical worktree, preserve machine-readable lineage with qualified `retryOf: "<workspaceKey>:<laneId>"`.