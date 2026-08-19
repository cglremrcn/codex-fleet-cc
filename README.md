# Codex Fleet for Claude Code

Claude Code is good at holding the whole job in its head. Codex is useful when part of that job
can be handed to an independent worker. Codex Fleet connects those two ideas without turning your
terminal into a pile of tabs.

Claude Code remains the orchestrator. It decides whether a task should stay local or become one
or more bounded Codex lanes. A lane can investigate, research, implement, operate a browser, or
verify another lane's result. Fleet Console gives you one keyboard-first view of those lanes:
what is running, which model and effort were selected, what authority each lane has, what evidence
it produced, and whether its result was independently verified.

Press `Ctrl+G` to temporarily hand the same terminal to Fleet Console. Press `q` or `Esc` to return
to the same Claude Code session, with the draft prompt left intact. Opening or viewing the console
does not create a Claude or Codex model turn.

Claude Code's `↓ to manage` hint belongs to Claude's own background-agent UI; it does not open or
navigate Fleet. Use `Ctrl+G` for Fleet, then the arrow keys or `j`/`k` inside the console.

> **Development preview:** the runtime, console, reversible setup, terminal handoff, live follow-up
> and exact owned-lane cancellation are implemented. The release gate passes on Windows, macOS
> Intel and Apple Silicon, Linux x64 and ARM64 with Node 22 and 24. The project is installable from
> its GitHub marketplace today; it is not yet published to a central marketplace catalog.

## Why this exists

Existing integrations can ask Codex to do a task, but a fleet creates harder questions:

- Which worker is allowed to write, browse, deploy, send, pay, or delete?
- Did a worker actually finish, or did it only say that it finished?
- Can several workers share one checkout without racing each other?
- What happens if a network call times out after an external mutation?
- Can I inspect the work without spending another model turn?
- Can I leave the dashboard and get back to the exact Claude session I was using?

Fleet treats those as product behavior, not prompt conventions. Roles do not grant authority.
`complete` is a worker claim; `verified` requires fresh evidence. Unknown external outcomes are not
blindly retried. One shared-checkout writer is allowed by default, and every wider capability is
explicit.

## How it fits together

```text
Claude Code
  ├─ orchestration skill     decides lane shape, authority and evidence contract
  ├─ /fleet:* commands       setup, doctor, status, result, follow-up and recovery
  └─ Ctrl+G handoff ──────────────────────────────────────┐
                                                         │ same terminal
Fleet Console                                            │
  ├─ lanes, evidence, authority and runtime health       │
  ├─ keyboard-first controls                             │
  └─ q / Esc ────────────────────────────────────────────┘

Fleet Runtime
  ├─ one local Codex app-server broker
  ├─ bounded lane scheduler
  ├─ fail-closed capability gates
  └─ private, redacted, atomic local state
```

Claude Code's supported external-editor action provides the terminal handoff. Fleet does not patch
Claude, inject keystrokes, run a nested Claude process, or open a permanent dashboard service.
The console starts on demand and exits completely when you return.

## The operator view

The interface is intentionally closer to an operator terminal than an AI chat dashboard:
near-black surfaces, dense alignment, restrained cyan and amber, green reserved for verified work,
and no ambient decorative motion. Its one living signature is KITE: a small terminal-native fleet
formation driven by the selected lane's real status. Active work assembles and releases the
formation at a capped four frames per second; completed work keeps a subtle awaiting-verification
motion; verified work locks it; blocked and failed work use distinct static postures. Wide terminals
show lanes, selected evidence, controls, and authority with visible panel focus.
Compact and narrow layouts progressively collapse KITE into a small signal sigil without hiding
essential controls.

![Fleet Console running four sanitized fixture lanes with KITE motion](docs/assets/fleet-console-kite-v3.gif)

This recording comes from the real renderer with sanitized fixture lanes. The PTY E2E opens the
preserved editor, returns to the fake Claude host, compares the draft byte-for-byte and confirms
that no owned child remains. It is not a product mockup or a claim about a live external account.

Core navigation is designed around:

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Select a lane |
| `Enter` | Inspect the selected lane |
| `Tab` | Move between panels |
| `/` | Filter lanes |
| `?` | Open contextual help |
| `m` | Send a bounded follow-up |
| `x` | Request confirmed cancellation |
| `e` | Open the editor Fleet preserved during setup |
| `p` | Pause or resume KITE motion |
| `q` / `Esc` | Return to Claude Code |

Mouse input is an optional convenience. Every essential operation remains available from the
keyboard. Linear plain-text status, monochrome output, reduced motion and narrow layouts are
implemented for screen readers and constrained terminals.

## Authority is part of the contract

A lane declares its role and its authority separately. An `implementer` is not automatically
allowed to write; a `researcher` is not automatically allowed to use a logged-in browser. The
contract can independently permit or deny:

- filesystem reads and writes;
- live network research;
- browser and account access;
- local process execution;
- database mutation;
- GPT Image 2 generation and editing;
- external send, payment, deployment, deletion, and retry.

The default is read-only and fail-closed. Mutable browser profiles, production tenants, and shared
checkouts are single-operator resources unless the contract explicitly isolates them. Cancellation
targets only the exact Codex thread and turn owned by the lane.

Image work uses explicit `image.generate` and `image.edit` grants. An approved visual lane routes
through Codex's built-in `$imagegen` capability (GPT Image 2), preserves edit sources unless replacement
was approved, copies the selected output into the project workspace, and returns the verified artifact
path. Fleet does not silently switch to an API-key script or another image provider.

Claude can also inspect status and results, then continue a completed lane in the same Codex task/thread.
If a worker merely asks for a redundant “say continue” approval even though the original contract already
granted the required authority, Claude sends a bounded follow-up and requires the actual work and evidence.
New scope, new authority, external effects, or a genuine user choice still stop for confirmation.

## Privacy and resource behavior

Fleet is local-only and telemetry-free by default. It uses the Codex CLI authentication,
configuration, MCP servers, and usage entitlement already present on the machine; it does not ask
for another API key or host user data.

Prompts and model reasoning are not persisted. Raw model output, cookies, access tokens, secrets,
and personal data are not stored in fleet state. The persisted index is limited to sanitized lane
metadata, progress, authority, evidence references, runtime identifiers, and token usage only when
Codex reports it. State is written atomically to a private per-user application-data directory.

The dashboard has no idle background UI process. The runtime shares one Codex app-server broker,
defaults to at most three active lanes and one writer per checkout, bounds retained history, and
redraws only when its view changes or a capped refresh tick fires.

The latest local Windows gate measured a 6.1 ms renderer-startup p95, 0% median CPU in the
synthetic idle harness, a configured 4 Hz refresh ceiling, 1.5 MiB retained heap growth for the
256-lane fixture, a 50,841-byte state snapshot and zero owned PTY children after exit. These are
development guardrails, not product workload or universal benchmarks; CI records the same
platform-specific evidence on every run.

## Current status

This table describes evidence available in the repository today, not the intended final support
matrix.

| Surface | Status |
| --- | --- |
| Windows live terminal handoff | **Proven** on Claude Code v2.1.234 in a disposable profile |
| Windows runtime and PTY fixture | Passing: installed launcher, exact draft, restored terminal, zero owned child |
| macOS Intel and Apple Silicon | Passing on Node 22/24: generated launcher command smoke and real PTY runtime |
| Linux x64 and ARM64 | Passing on Node 22/24: generated launcher command smoke and real PTY runtime |
| Fleet Console | Renderer, controller, input, accessibility and fixture E2E implemented |
| Marketplace install | Available from the GitHub personal marketplace; not yet published to a central catalog |
| Reversible settings setup | Preview/apply/uninstall, rollback and late-mutation refusal tested |
| Real Codex account workflow | Passing on August 19, 2026 with Codex CLI 0.147.0: investigator and same-thread follow-up read separate random nonces, an independent verifier rechecks both, then exact cancellation completes |
| Live cross-process follow-up/cancel | Passing through the authenticated local supervisor; `m` follows up and `x` previews then confirms exact cancellation |

Cross-platform support is gated by Windows, macOS and Linux CI plus PTY handoff tests on every
change and release tag. Capability discovery remains separate from a successful live capability
smoke.

## Install from GitHub

Fleet uses Claude Code's supported personal-marketplace flow. In Claude Code's terminal, run:

```bash
claude plugin marketplace add cglremrcn/codex-fleet-cc
claude plugin install fleet@codex-fleet-cc
```

Reload plugins or restart Claude Code:

```text
/reload-plugins
```

On the first session without a Fleet ownership manifest, Claude asks one question: `Enable Ctrl+G
Fleet Console now?` Answer yes and Claude previews and applies the reversible integration itself.
There is no command or integrity token to copy. The SessionStart check is read-only; it cannot
change settings before that explicit confirmation. Restart Claude Code once after setup, then press
`Ctrl+G` to enter Fleet Console. Use `q` or `Esc` to return to the same Claude Code session.

Run `/fleet:doctor` when you want an explicit capability report. `/fleet:setup` remains available as
a manual recovery path, but it is not part of normal first-run onboarding.

### Migrating from the legacy standalone skill

The plugin contains the maintained `codex-fleet-orchestrator` skill. If a profile still has the
older standalone directory below, archive or remove it before restarting Claude Code:

```text
~/.claude/skills/codex-fleet-orchestrator/
```

Keeping both copies gives Claude two skills with the same discovery name. The plugin replaces that
prompt-only version with runtime-enforced scheduling, authority gates, independent verification,
owned follow-up and cancellation, and Fleet Console. Do not merge their instruction files.

## Work with the source

For development and review:

```bash
git clone https://github.com/cglremrcn/codex-fleet-cc.git
cd codex-fleet-cc
npm ci
npm run verify
```

Maintainers can run the explicit real-account release smoke in a disposable temporary workspace:

```bash
npm run smoke:live
```

That smoke uses ephemeral read-only lanes, retains no prompt or runtime identifiers in its output,
and stops the exact supervisor and Codex process tree it owns before deleting the workspace.

The project keeps Node.js 22.20 as its compatibility floor, matching the Claude Code CLI runtime,
and tests the maintained Node 22 and current Node 24 LTS lines. Fleet has no production npm
dependencies.
`node-pty` is development-only and is excluded from the plugin package.
The GitHub marketplace installs the packaged plugin. Source contributors should still use the
checkout above. Automatic onboarding and manual `/fleet:setup` both use the same immutable preview
and explicit-confirmation boundary before applying anything to a Claude Code profile.

The plugin contract uses Claude Code's marketplace/plugin directory mechanism and these commands:

```text
/fleet:setup      preview and apply the reversible terminal handoff
/fleet:doctor     test local runtime and optional capabilities
/fleet:status     show a compact evidence-oriented status
/fleet:open       show the configured Fleet shortcut
/fleet:result     inspect a sanitized lane result
/fleet:follow-up  continue a completed lane on its existing Codex thread
/fleet:cancel     request confirmed cancellation
/fleet:export     preview and create a redacted support bundle
/fleet:uninstall restore only settings owned by Fleet
```

Those commands are the public contract. Setup and uninstall use separate immutable previews and
exact confirmation tokens. SessionStart only detects missing setup; after one plain user
confirmation, setup carries its token internally. Users never need to copy or paste it. Inside Fleet
Console, `m` continues the selected completed lane on its existing Codex thread and `x` performs an
immutable preview before cancelling only the pinned owned thread and turn.

## Safety decisions that should not be “simplified”

- A lane's role never implies authority.
- Read-only status must not modify the repository.
- A completed lane is not displayed as verified without an independent verifier.
- External effects with an unknown outcome block automatic retry until reconciled.
- User input never enters a shell command string.
- Setup structurally merges settings, shows an exact preview, and records ownership hashes.
- Uninstall refuses to overwrite editor settings that changed after Fleet setup.
- The console never edits Claude's draft file unless the preserved editor is explicitly opened.
- Support exports require a preview and omit prompts, secrets, cookies, and canonical private paths.

## Development principles

Production behavior is built with RED–GREEN–REFACTOR: a failing test first, the smallest behavior
that makes it pass, then refactoring under the green suite. Platform claims require verification in
the platform that matters. Mock-green does not mean PTY-green, and PTY-green does not mean a live
Claude profile is safe to modify.

The implementation plan and current release gates live in
[`docs/superpowers/plans/2026-08-17-codex-fleet-cc-implementation.md`](docs/superpowers/plans/2026-08-17-codex-fleet-cc-implementation.md).
The approved product and threat-boundary design lives in
[`docs/specs/2026-08-17-codex-fleet-cc-design.md`](docs/specs/2026-08-17-codex-fleet-cc-design.md).

## Project guides

- [Architecture](ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Upstream and license

The Codex runtime layer is derived from OpenAI's
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), inspected from commit
`db52e28f4d9ded852ab3942cea316258ae4ef346`. Required upstream notices and the full license are
retained in [`NOTICE`](NOTICE), [`LICENSE`](LICENSE), and the installable plugin tree.

This project is licensed under Apache-2.0. It is an independent community project and is **not affiliated with or endorsed by OpenAI or Anthropic**. “OpenAI”, “Codex”, “Anthropic”, and “Claude”
remain trademarks of their respective owners.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before a broad change. Bug and feature forms are available
in GitHub. Report vulnerabilities through the private path described in [SECURITY.md](SECURITY.md),
never in a public issue. Do not attach credentials, prompts, customer data or unsanitized support
output.
