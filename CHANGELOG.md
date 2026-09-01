# Changelog

## 0.2.1 — 2026-09-01

- Make `/fleet:doctor` resolve the exact first Codex executable on `PATH`, matching the app-server
  broker. On Windows, an earlier npm `codex.cmd` wrapper now wins over a later desktop `codex.exe`.
- Invoke resolved Windows diagnostic wrappers through a trusted absolute `ComSpec` with bounded literal
  arguments, preserving the fail-closed command boundary.

Migration: update `fleet@codex-fleet-cc`, accept the versioned runtime upgrade, restart Claude Code,
confirm `v0.2.1` in the Fleet masthead and run `/fleet:doctor`.

## 0.2.0 — 2026-09-01

- Normalize lane results around four required fields while retaining optional artifact, verification,
  commit and configuration evidence. Git commit claims are resolved in the admitted workspace before
  completion can be accepted.
- Reconcile a timed-out post-send `start` by exact admission ID and immutable lane identity. Partial or
  absent evidence returns outcome unknown and explicitly forbids blind redispatch.
- Recover formerly non-terminal persisted work as `interrupted`, preserve its thread/evidence and record
  workspace dirtiness only as a workspace-level observation pending controller reconciliation.
- Propagate each lane's read-only/workspace-write and network authority to app-server thread, resume and
  turn policies. Add a Windows exact-argv `command/exec` diagnostic with a bounded kill switch and no
  unsandboxed fallback.
- Add complete JSON status, attention-first human status, `--all`, `--limit`, repeatable `--status`,
  `--since`, and decoded `result --pretty` / `result --summary` output.
- Add PageUp/PageDown, Home/End, stable lane-ID selection and visible-range paging for large fleets.
  Snapshot reads are bounded; stale reads retain the last good frame without blocking input or quit.
- Centralize lane execution posture: the controller owns commits, PowerShell 5.1 commands avoid `&&`,
  intermediate evidence is persisted before long suites and sandbox-blocked build/dev-server checks are
  returned for controller verification.
- Pin the validated Claude Code CLI at 2.1.252 and align all release/default surfaces at 0.2.0.

Known limitations: desktop MCP discovery is not proof of lane injection; Playwright signed-in profile
concurrency remains external and single-operator; interrupted or externally uncertain effects require
manual reconciliation; a plugin reload does not by itself upgrade the owned terminal runtime.

Migration: reload/install the 0.2.0 plugin, accept the versioned Fleet setup upgrade for the second
runtime surface, restart Claude Code, confirm `v0.2.0` in the Fleet masthead and run `/fleet:doctor`.

## 0.1.7 — 2026-08-20

- Replace internal five-panel counters with three named operator views and explicit keyboard
  destinations across wide, compact, narrow, monochrome, and screen-reader-safe layouts.
- Add a visible lane-search row with match counts, a fixed session composer, truthful `LIVE STEER`
  and `FOLLOW-UP` modes, collapsed safe activity, local slash commands, and bounded transcript scroll.
- Keep KITE motion visible through a compact status-driven indicator while preserving pause and
  reduced-motion behavior.
- Discover the enabled system `imagegen` skill through Codex app-server and inject it explicitly into
  initial, continued, resumed, and steered image work; missing or malformed capability fails closed.
- Reconcile Windows process-tree shutdown races only after the exact owned PID is confirmed absent;
  live or reused PIDs remain fail-closed with structured broker diagnostics.
- Document that Claude's local plugin inventory is not the Codex ImageGen capability boundary.

## 0.1.6 — 2026-08-20

- Open the selected real Codex app-server thread from Fleet Console with `Enter` or `m`, send a
  same-thread message with `Enter`, and return with `Ctrl+G`.
- Keep KITE visibly alive for queued, running, and completed-but-unverified lanes while preserving
  reduced-motion and locked verified states.
- Add strict, evidence-bearing structured outcomes and at most two bounded same-thread recoveries for
  plan-only or redundant-approval responses.
- Route new authority, external effects, missing inputs, material user choices, and runtime blockers to
  the Claude controller without silently widening lane authority.
- Preserve terminal lane records across rejected or interrupted follow-ups; uncertain mutable outcomes
  fail closed as `outcome_unknown` instead of being retried.
- Add validated model/effort literals, complete role documentation, executable contract templates, and
  GPT Image 2 lane routing with parent visual inspection.
- Add version-aware Ctrl+G integration upgrades with staged runtime swaps, downgrade refusal,
  ownership-safe rollback, and recovery-artifact retention when rollback cannot be proven complete.
- Surface recovery, controller requests, pending continuation reconciliation, and loaded integration
  version in interactive and plain status views.
