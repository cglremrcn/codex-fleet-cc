# Changelog

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
