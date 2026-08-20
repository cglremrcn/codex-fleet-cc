# Threat model

## Scope

Codex Fleet is a local orchestration plugin. It coordinates Claude Code, the local Codex CLI,
Codex app-server, source workspaces, a same-terminal console and optional capabilities already
configured on the user's machine. It does not provide a hosted service.

## Assets

- source code and uncommitted workspace changes;
- Claude draft content and preserved editor configuration;
- Codex authentication and local MCP configuration;
- browser sessions and external accounts explicitly granted to a lane;
- sanitized lane state, evidence references and support bundles;
- terminal integrity and local process ownership;
- release archive, dependency lock and upstream attribution.

## Actors

- The user is trusted to grant authority and confirm effects.
- Claude is the orchestration boundary but can make mistakes.
- Codex lanes and their output are untrusted until verified.
- Repository content, prompts, tool output and terminal text may be malicious.
- Local processes outside Fleet are unowned.
- Dependency registries, GitHub Actions and upstream releases are supply-chain boundaries.

## Trust boundaries

### Claude to Fleet CLI

Input crosses as bounded JSON. Unknown fields, oversized input, malformed UTF-8 and inline task
text are rejected. Role names do not alter authority.

### Fleet to Codex app-server

The runtime adapter exposes only start, continue, interrupt, inspect, list and close. It uses
argument vectors without a shell. Protocol mismatch blocks mutation while preserving safe
inspection when possible.

### Runtime to disk

State is sanitized, bounded and atomic. Canonical workspace paths are replaced by hashes. Symlink
ancestors, traversal and unknown schemas fail closed. Corrupt state is quarantined.

### Console to terminal

Displayed fields are bounded and control characters are removed. The terminal lifecycle restores
raw mode, alternate screen, cursor, bracketed paste and mouse state after normal exit, exception or
signal. Viewing starts no model operation.

### Fleet to external systems

Network, browser mutation, GPT Image generation/editing, send, payment, deployment and deletion are
separate authorities. A confirmation reference is bound to the proposed effect. Timeout after a
possible effect produces `OUTCOME_UNKNOWN`, which blocks blind retry.

## Primary threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Prompt or repository injection broadens authority | Authority is structured and validated outside the prompt | The orchestrator may propose a poor plan; the user must inspect effect confirmations |
| Shell injection | Fixed executables and argument arrays; no shell interpolation | A trusted executable on `PATH` could be replaced outside Fleet's control |
| Cross-workspace disclosure | Hashed workspace keys, owned paths, redaction | Evidence files intentionally referenced by a lane remain governed by workspace permissions |
| PID reuse kills another process | PID plus process-start identity | Platform process APIs can fail, in which case cancellation denies |
| Duplicate external mutation | Exact confirmation and unknown-outcome reconciliation | Providers without idempotency still require operator reconciliation |
| Unapproved or substituted image generation | Explicit image authority plus app-server discovery and exact `imagegen` skill injection before every image turn | Built-in generation still depends on the user's Codex entitlement and runtime availability |
| Terminal escape injection | Bounded sanitized display and pure renderer | Terminal emulator vulnerabilities are outside Fleet |
| Settings loss | Structural merge, backup, ownership manifest and drift-aware uninstall | Manual edits during setup require a fresh preview |
| Secret leakage in support output | Preview, redaction rules and bounded export | Novel credential formats may require new rules |
| Dependency compromise | Exact lockfile, zero production dependencies, license/secret checks, Dependabot and CodeQL | Development PTY tooling still executes native code in test environments |
| False verification | Fresh verifier and evidence references | Verification quality depends on the verifier's contract and accessible evidence |

## Native development dependency

`node-pty` is used only by PTY tests. It is not included in the installable plugin archive. The
test runs in a dedicated process because the Windows ConPTY worker can retain a native MessagePort
after the terminal has naturally exited. The harness emits its bounded result, proves no owned
child remains and then exits its own process.

## Out of scope

- compromise of Claude Code, Codex CLI, the operating system or terminal emulator;
- a user intentionally granting broad authority to malicious work;
- security of third-party MCP servers or browser extensions;
- correctness of external provider idempotency;
- recovery of secrets already written to repository history outside Fleet.

Report new boundary failures through [SECURITY.md](../SECURITY.md).
