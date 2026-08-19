# Live Control Release Design

## Goal

Complete the product loop promised by Codex Fleet: Claude Code dispatches bounded Codex lanes,
the user opens Fleet Console in the same terminal, observes real work, sends a follow-up or cancels
the exact owned turn, and returns to the unchanged Claude session. The release must prove this with
a real logged-in Codex account and equivalent terminal handoff evidence on Windows, macOS and Linux.

## Decisions

Fleet will own a local supervisor rather than use Codex's experimental WebSocket transport. The
supervisor is workspace-scoped, starts only when a lane needs runtime work, and exits after the
workspace becomes idle. It owns one Codex app-server process and is the only writer of live lane
state. Clients connect through a Unix socket on macOS/Linux or a named pipe on Windows.

The supervisor manifest is stored in Fleet's private per-user data directory. It contains a bounded
protocol version, endpoint, random capability token, PID and process-start identity. A client must
prove the workspace key and capability token. Shutdown or stale-session cleanup must verify PID and
process-start identity before terminating anything. Messages are length-bounded JSONL; prompts and
follow-up text are never persisted to state or logs.

Fleet CLI keeps synchronous behavior for compatibility and adds explicit background admission for
Claude's lane bridge. Background start returns after the supervisor accepts immutable contracts.
Status and result stay read-only. Follow-up resumes the recorded thread through the supervisor and
starts a new turn. Cancellation includes the expected thread and turn identity and is rejected when
the target changed. A stopped or absent supervisor can be restarted for a completed-thread
follow-up, but cancellation fails closed when the original active turn cannot be proven.

Fleet Console receives a control client, not raw app-server access. Pressing `m` opens a bounded
single-line composer; Enter submits, Escape cancels, and Backspace edits. Pressing `x` snapshots the
selected lane identity and `c` confirms only that snapshot. The supervisor repeats every authority,
status and ownership check; TUI checks are usability hints, never the security boundary.

## State and lifecycle

Persisted lane metadata includes sanitized authority, thread and turn identifiers, timestamps,
status, model, effort and bounded result summary. It excludes prompts, reasoning, credentials,
cookies and raw tool output. State writes remain atomic and lock-protected. Supervisor startup uses
an exclusive startup lock; competing clients either connect to the proven owner or fail closed.

When no lane is queued or active and no control request is running, the supervisor exits. A later
follow-up starts a new supervisor, resumes the persisted Codex thread, and records the new turn.
There is no idle dashboard process and opening the console does not create a model turn.

## Verification

Unit and integration tests use a real local socket/pipe and the fake app-server only at the external
Codex boundary. They cover concurrent startup, stale manifests, wrong tokens, oversized messages,
wrong workspace, PID reuse, follow-up state transitions and target-pinned cancellation.

The PTY release smoke must execute the setup-generated launcher on every OS, open the original
editor, return to the fake Claude host, preserve the draft byte-for-byte, uninstall, and leave no
owned child process. The live smoke is opt-in, uses the existing ChatGPT Codex login, a disposable
workspace, read-only ephemeral investigator and independent verifier threads, a follow-up turn and
an immediately interrupted disposable lane. It records only IDs, statuses, timings and boolean
assertions.

## Release gate

The work is releasable only when the full local gate passes, the live smoke passes, the five-runner
Node 22/24 matrix passes, strict plugin validation passes, deterministic packaging succeeds, and a
GitHub pull request is green. Merge happens remotely so the user's dirty local `main` checkout is
not modified.
