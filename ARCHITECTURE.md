# Architecture

Codex Fleet is a local Claude Code plugin with three deliberately separate layers. Claude owns
intent and orchestration, the Fleet runtime owns bounded execution and evidence, and Fleet Console
owns display and operator input. None of those layers can silently borrow authority from another.

## Runtime shape

```text
Claude Code
  │  lane contracts and explicit confirmations
  ▼
Fleet CLI ── scheduler ── runtime adapter ── one Codex app-server broker
  │               │                │
  │               │                └─ Codex threads and turns
  │               └─ concurrency and one-writer limits
  └─ redacted atomic state
                  │
                  ▼
             Fleet Console
```

The public plugin lives in `plugins/fleet`. It contains the Claude manifest, skills, hook, lane
agent, deterministic CLI, console and runtime modules. The root repository contains tests,
development-only PTY tooling, CI and release packaging. `node-pty` is never shipped in the plugin;
it exists only to verify the terminal handoff.

## Control flow

1. The orchestration skill chooses the smallest lane topology that can produce independent
   evidence.
2. Each lane receives an immutable contract: objective, exclusions, authority, capability
   evidence, deliverable, verification and cleanup.
3. The CLI and supervisor use one shared admission validator that returns every input and authority
   issue before opening the runtime.
4. The scheduler caps active lanes and serializes writers that share a checkout.
5. The runtime adapter maps the stable Fleet operations to Codex app-server threads and turns.
6. Sanitized lane metadata is written atomically outside the repository.
7. Fleet Console reads that state. Viewing does not start a model turn.
8. A fresh verifier can promote `COMPLETE` to `VERIFIED` only with evidence references.

## Authority model

Role names are descriptive. They grant nothing. Filesystem writes, network, browser inspection,
browser mutation, process control, database access, GPT Image generation/editing, send, payment,
deployment and deletion are independent capabilities. Unknown capabilities deny by default.

Operations with an external effect require confirmation bound to that exact action. If the effect
may have happened but cannot be proven, the lane becomes `OUTCOME_UNKNOWN`; automatic retry stops
until reconciliation evidence exists.

Process cancellation uses both PID and process-start identity. This prevents a recycled PID from
targeting an unrelated process. Codex thread interruption remains the preferred control when a lane
has an active owned turn.

Claude controls lanes only through Fleet's start, status, result, follow-up and cancellation-preview
surface. A follow-up resumes the persisted Codex thread without changing its admitted authority.

## State and privacy

Fleet state is stored in the platform user-data directory:

- Windows: `%LOCALAPPDATA%/codex-fleet-cc`
- macOS: `~/Library/Application Support/codex-fleet-cc`
- Linux: `${XDG_STATE_HOME}/codex-fleet-cc` or `~/.local/state/codex-fleet-cc`

Workspace paths are represented by a truncated SHA-256 key. State is capped at 256 lanes and
2 MiB per workspace, written through a same-directory temporary file and atomic rename. Symlinks,
path traversal and unknown schemas fail closed.

Prompts, reasoning, cookies, credentials and raw output are not persisted. The state index keeps
only sanitized progress, authority, runtime identifiers, evidence references and reported token
usage.

## Terminal lifecycle

Claude Code's supported external-editor action temporarily gives the existing terminal to Fleet
Console. Fleet enters raw mode and the alternate screen only after confirming interactive streams.
Normal exit, errors and signals restore cursor, mouse, paste, alternate-screen and raw-mode state.
The original editor command is preserved and can be opened from Fleet without changing Claude's
draft file.

The renderer is pure. Wide, compact, narrow, monochrome, reduced-motion and screen-reader modes
share one view model. KITE motion is derived from lane state and capped at four frames per second.
`COMPLETE` remains subtly active while awaiting independent verification; `VERIFIED` and attention
states are locked. Panel focus and motion changes always produce visible text feedback.

## Verification boundary

Unit tests prove state and policy behavior. Fake app-server tests prove the adapter and shared
broker. PTY tests prove terminal ownership and draft preservation. Platform claims require the
matching GitHub runner and a real Claude smoke; one environment never substitutes for another.

See the [threat model](docs/THREAT_MODEL.md), [security policy](SECURITY.md) and
[implementation plan](docs/superpowers/plans/2026-08-17-codex-fleet-cc-implementation.md).
