# Codex Fleet for Claude Code — Design Specification

**Status:** Approved for implementation

**Date:** 2026-08-17

**Working name:** Codex Fleet for Claude Code

**Repository slug:** `codex-fleet-cc`

## 1. Product outcome

Codex Fleet lets a Claude Code user delegate bounded work to one or more Codex agents, observe
and steer the fleet from a full-screen terminal dashboard, and return to the same Claude Code
conversation without opening a second terminal or running Claude inside another host process.

The product is a project-independent, open-source Claude Code plugin plus orchestration skill. It
uses the user's existing Codex authentication, configuration, MCP servers, and usage entitlement.
It does not introduce a hosted service or require an additional API key.

### Success criteria

1. A user invokes the skill naturally or through a `/fleet:*` command.
2. Claude decomposes the request into the smallest useful set of bounded Codex lanes.
3. The user presses a configurable Fleet shortcut and Claude Code yields the same terminal to the
   dashboard through its supported external-editor handoff.
4. The dashboard supports keyboard-first and optional mouse navigation across active, completed,
   failed, and blocked lanes.
5. Exiting with `q` or `Esc` returns to the same Claude Code session with the draft prompt intact.
6. Static viewing consumes no Claude tokens. Opening the dashboard adds no Codex model turn.
7. The default installation is local-only, telemetry-free, fail-closed, and cross-platform.

The zero-model-turn guarantee applies to opening and viewing Fleet Console through Claude's
external-editor keybinding. Natural-language and `/fleet:*` interactions can require a Claude
turn and must never be described as free.

## 2. Proven foundation

### Claude Code handoff

Claude Code exposes `chat:externalEditor` through its keybinding system. A live smoke on Claude
Code v2.1.233 in a Windows PTY proved that the action:

- suspends Claude's full-screen renderer;
- starts a configured terminal application in the same PTY;
- accepts terminal ownership until that application exits;
- restores the same Claude conversation afterward.

The product uses this supported handoff instead of terminal injection, binary patching, nested
Claude processes, or a second terminal window.

This smoke proved terminal ownership and same-session restoration on Windows. It did not yet
prove the production Node input loop, mouse decoding, or macOS/Linux behavior; those remain
explicit release gates.

### Codex runtime

[OpenAI's `openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) already provides an
Apache-2.0 Claude Code integration based on the local Codex CLI and Codex app server. Design work
inspected upstream commit `db52e28f4d9ded852ab3942cea316258ae4ef346`. The project will derive
its runtime layer from that implementation and retain all required Apache-2.0 `LICENSE` and
`NOTICE` material.

The forked/derived code will be isolated behind a runtime adapter so upstream changes can be
merged or replaced without coupling the dashboard and orchestration policy to private internals.

## 3. Architecture

```text
Claude Code
  ├─ codex-fleet-orchestrator skill     intent, decomposition, authority, evidence
  ├─ /fleet:* plugin commands           setup, doctor, status, open hint, export, uninstall
  ├─ local launcher                     deterministic runtime operations
  └─ external-editor handoff ─────────────┐
                                           │
Fleet Console                              │ same terminal, temporary ownership
  ├─ dashboard renderer                   │
  ├─ keyboard/mouse controller            │
  ├─ command palette                      │
  └─ read-only state client by default ───┘

Fleet Runtime
  ├─ one shared Codex app-server broker per user
  ├─ bounded Codex thread/lane manager
  ├─ capability and authority gates
  ├─ atomic local state/evidence index
  └─ lifecycle, recovery, and resource governor
```

### Component boundaries

#### Orchestration skill

The existing `codex-fleet-orchestrator` guidance remains the control policy. It is shortened into
a progressive-disclosure entry point and references dedicated documents for capability routing,
prompt contracts, evidence, fleet patterns, runtime operation, and UI use.

It remains model-agnostic on the Claude side and project-agnostic. No application-specific rules,
paths, accounts, prompts, or credentials are shipped.

#### Runtime adapter

The runtime adapter owns communication with Codex app-server. It exposes stable internal methods
for starting, continuing, interrupting, listing, and inspecting lanes. It never exposes raw app-
server protocol details to the dashboard or skill.

#### Fleet state

State is stored under the platform's per-user application-data directory, not in the repository.
Each workspace is keyed by a canonical-path hash. Writes use atomic replace and a process lock.

Persisted metadata is limited to:

- lane ID, role, task label, workspace identifier, model, effort, sandbox, and capability set;
- process/thread identifiers, timestamps, phase, status, token usage when supplied by Codex;
- sanitized progress summaries, evidence paths, exit reason, and restart handoff;
- explicit external-side-effect and cleanup state when applicable.

Prompts, model reasoning, secrets, cookies, tokens, raw personal data, and full command output are
not persisted by default.

#### Fleet Console

The dashboard is an on-demand Node terminal program using raw TTY input and ANSI alternate-screen
rendering. It has no long-lived UI process and no framework runtime. It redraws only on state,
selection, resize, or a bounded refresh tick. The language and dependency choice is provisional
until the implementation plan measures startup, memory, packaging, and PTY support against the
release budgets.

## 4. User experience

### Primary flow

1. User opens Claude Code normally.
2. User gives a task and asks Claude to use Codex, or Claude selects the skill when appropriate.
3. Claude presents the lane plan when authority or side effects require confirmation.
4. Runtime starts the authorized lanes and prints a one-line Fleet summary plus the dashboard key.
5. User presses the configurable shortcut, defaulting to `Ctrl+G`.
6. Fleet Console opens in the same terminal.
7. User navigates and optionally performs an allowed control action.
8. User presses `q` or `Esc`; Fleet Console exits and Claude Code resumes unchanged.

`Ctrl+G` replaces Claude's ordinary external-editor entry point. Setup preserves the user's prior
`VISUAL`/`EDITOR` command, and the dashboard provides `e` to open that original editor. Users may
choose a different Claude keybinding during setup.

Claude passes the current draft-prompt file to the configured editor command. Fleet Console treats
that path as an opaque handoff value, never modifies it during dashboard use, and passes the same
path to the preserved editor when the user presses `e`. Exiting the preserved editor returns to
Fleet Console; exiting Fleet Console returns to Claude with the draft intact.

Claude Code currently exposes no supported plugin API that programmatically triggers
`chat:externalEditor`. `/fleet:open` therefore reports availability and the configured shortcut;
the user performs the handoff with that shortcut.

### Bloomberg-inspired visual language

The interface is data-dense but not noisy:

- near-black and graphite surfaces;
- cool cyan for selection and navigation;
- restrained amber for attention and active work;
- green only for verified completion;
- red only for failed or denied states;
- monospaced type, hard alignment, thin separators, no gradients, no decorative animation;
- short verbs and evidence-first labels instead of chatty AI copy.

The visual identity must feel like an operator console, not a generic AI dashboard.

### Responsive layouts

#### Wide: 120 columns or more

```text
┌ FLEET / workspace / branch ───────── totals / limits / runtime health ┐
│ LANES                    │ SELECTED LANE              │ AUTHORITY      │
│ status role task         │ phase, progress, evidence  │ model / effort │
│                          │ recent safe events         │ sandbox / caps │
├──────────────────────────┴────────────────────────────┴────────────────┤
│ command palette / shortcuts / warnings / last refresh                 │
└────────────────────────────────────────────────────────────────────────┘
```

#### Compact: 80–119 columns

Two columns: lane list and selected-lane detail. Authority and capability data become tabs.

#### Narrow: below 80 columns

One focused panel at a time. `Tab` cycles list, detail, evidence, and controls. No horizontal
scrolling is required for essential information.

### Navigation

| Input | Action |
|---|---|
| `↑` / `↓`, `j` / `k` | Select lane |
| `Enter` | Open selected lane detail |
| `Tab` / `Shift+Tab` | Cycle panels |
| `/` | Filter lanes |
| `?` | Contextual help |
| `e` | Open preserved external editor |
| `m` | Send a bounded follow-up to the selected lane |
| `x` | Request cancellation with confirmation |
| `r` | Retry only when outcome reconciliation permits it |
| `c` | Copy safe lane/thread identifier |
| `q` / `Esc` | Return to Claude Code |

Mouse support is optional enhancement. Every action must be available from the keyboard.

### Truthful display

- Display token usage only when the Codex runtime reports it.
- Never infer monetary cost from subscription use.
- Display reasoning summaries only when intentionally emitted; never claim to show chain of
  thought.
- Distinguish `COMPLETE`, `VERIFIED`, `BLOCKED`, `FAILED`, `CANCELLED`, and `OUTCOME_UNKNOWN`.
- Show capability discovery separately from successful capability smoke evidence.

## 5. Fleet orchestration

### Lane roles

- investigator
- current-web researcher
- planner
- implementer
- browser/QA operator
- visual analyst
- integrator
- independent verifier

Roles do not grant authority. Each lane separately declares sandbox, network, browser/account,
filesystem, and external-effect permissions.

### Default topology

- Use one lane for an atomic task.
- Use two to four read-only lanes for independent evidence surfaces.
- Use one writer per shared checkout.
- Use isolated Git worktrees for genuinely independent writers.
- Use one operator for each mutable browser profile, account, database, or external tenant.
- Always use a fresh lane for independent verification.

### Resource governor

Defaults are conservative and configurable:

- maximum active Codex lanes: 3;
- maximum write-capable lanes per checkout: 1;
- stagger concurrent starts;
- one shared app-server broker;
- no dashboard polling faster than four refreshes per second;
- bounded retained job history by count and age;
- automatic process cleanup only for processes proven to belong to the current fleet;
- no automatic retry for unknown external outcomes.

The dashboard itself starts only on demand and exits completely on return to Claude.

## 6. Security and privacy

### Trust model

Claude remains the authority and integration boundary. Codex lanes are untrusted workers with
bounded contracts. A lane completion message is a claim until verified against evidence.

### Required controls

- local-only IPC using platform-local sockets/pipes; no listening TCP port by default;
- restrictive per-user state permissions and symlink/path traversal protection;
- command allowlist rather than arbitrary shell execution from the dashboard;
- argument-vector process spawning without shell interpolation;
- secret and personal-data redaction before persistence or display;
- no telemetry by default; any future analytics are explicit opt-in and metadata-only;
- explicit confirmation for cancel, retry, write escalation, send, payment, deploy, delete, or
  external mutation;
- fail-closed capability and permission checks;
- repository dirty-state protection and exact process ownership checks;
- bounded output and state sizes to prevent memory/disk exhaustion;
- safe terminal restoration on crash, signal, resize, and forced exit.

### Supply chain

- pin runtime dependencies and commit the lockfile;
- minimize production dependencies;
- run dependency review, license checks, secret scanning, and release provenance in CI;
- publish checksums and signed provenance for release artifacts when binary distribution is added;
- retain OpenAI Apache-2.0 license and notice obligations for derived code;
- state clearly that the community project is not an official OpenAI or Anthropic product.

## 7. Cross-platform contract

Supported targets:

- Windows 10/11 with a VT-capable terminal, including Windows Terminal and supported IDE
  terminals;
- current and previous major macOS releases on Intel and Apple Silicon;
- mainstream x64/arm64 Linux distributions with a UTF-8, ANSI-capable terminal.

Platform-specific paths, process control, sockets, signals, and permissions live behind adapters.
The core state machine, renderer model, commands, and orchestration contracts are platform-
neutral.

Accessibility and compatibility:

- `NO_COLOR` and monochrome modes;
- ASCII border fallback when Unicode width is unreliable;
- keyboard-only operation;
- reduced-motion behavior by default;
- terminal resize and small-window recovery;
- screen-reader mode that emits a linear status report instead of the alternate-screen dashboard.

No release is labelled cross-platform until Windows, macOS, and Linux CI plus PTY smoke tests pass.

## 8. Commands and installation

Planned public commands:

- `/fleet:setup` — install/check Codex, configure the safe handoff and keybinding, preserve editor;
- `/fleet:doctor` — verify Claude plugin, Codex auth/runtime, app-server, web/browser/image surfaces;
- `/fleet:status` — request a compact fleet status in the Claude transcript;
- `/fleet:open` — print the configured Fleet shortcut and current availability;
- `/fleet:cancel [lane|all]` — confirmed cancellation;
- `/fleet:result [lane]` — show the stored evidence-oriented result;
- `/fleet:export` — export a sanitized support bundle after preview/consent;
- `/fleet:uninstall` — restore editor/keybinding settings and remove only owned state.

Natural-language use remains primary. Commands are deterministic escape hatches, not a second
workflow the user must learn.

Plugin slash commands may consume a Claude turn. Deterministic zero-model runtime inspection is
provided by Fleet Console and the local `fleet` CLI, not promised for `/fleet:*` commands.

Installation will support Claude Code's plugin marketplace flow. Development mode supports
`claude --plugin-dir ./codex-fleet-cc`. Setup must be reversible and may not overwrite settings
without a structural merge and explicit preview.

## 9. Failure and recovery

- Broker crash: preserve atomic lane metadata, restart once, then mark blocked with diagnostics.
- Dashboard crash: restore terminal mode and Claude screen; do not terminate Codex lanes.
- Claude restart: mark process-local handles stale, reconcile app-server threads and owned jobs.
- Codex timeout: inspect thread/job state before retrying.
- External mutation timeout: mark `OUTCOME_UNKNOWN` and prohibit blind retry.
- Corrupt state: quarantine the single workspace state file, preserve a support copy, and rebuild
  only from authoritative runtime state.
- Version mismatch: block unsafe commands, show exact installed/required versions, keep read-only
  status available when possible.
- Missing color/mouse/Unicode support: degrade presentation without losing control functions.

## 10. Testing and release gates

Development follows RED–GREEN–REFACTOR. Production behavior is not written before a failing test.

### Automated gates

- unit tests for parsing, state transitions, authority checks, redaction, path safety, and render
  layout;
- golden/snapshot tests for wide, compact, narrow, monochrome, and screen-reader views;
- property tests for hostile dimensions, malformed events, oversized fields, and Unicode width;
- integration tests against the official fake Codex app-server fixture pattern;
- PTY tests for key navigation, mouse decoding, terminal restoration, signals, and Claude
  external-editor return;
- process tests for cancellation ownership and orphan prevention;
- Windows/macOS/Linux CI matrix;
- dependency, license, secret, and static security scans;
- performance budgets for idle CPU, refresh rate, startup latency, retained memory, and state size;
- skill RED/GREEN forward tests using fresh Claude contexts;
- end-to-end smoke: Claude → skill → Codex fleet → dashboard → follow-up → verifier → Claude.

### Release criteria

- all platform gates green;
- no unresolved high-severity security findings;
- clean install and uninstall verified on all targets;
- no repository modifications from status-only use;
- no secrets in exported state or diagnostics fixtures;
- fresh independent verification of the tagged source and packaged plugin;
- demo recording and documentation match the released behavior.

## 11. Open-source product quality

The repository will include a concise README, architecture overview, threat model, contribution
guide, code of conduct, security policy, issue templates, demo assets, and reproducible release
workflow. Documentation will lead with a thirty-second install and a short visual demonstration.

Viral features must also be useful:

- a polished terminal recording that reveals the fleet progressively;
- shareable, sanitized run summaries with no prompt or secret leakage;
- preset lane compositions such as Research, Build, Adversarial Review, Release Gate, and Browser
  QA;
- themes implemented as data, with a restrained default identity;
- transparent resource and capability indicators that make the system trustworthy rather than
  merely impressive.

## 12. Non-goals

- modifying or patching Claude Code's closed native renderer;
- hosting user prompts, credentials, or source code;
- exposing hidden model reasoning;
- replacing Codex authentication, billing, configuration, or MCP management;
- automatically granting broad filesystem, network, browser, or production authority;
- claiming every terminal emulator is equivalent without testing it;
- duplicating the official Codex plugin runtime without a concrete fleet requirement.

## 13. Acceptance checklist

- [ ] Same-terminal Fleet entry and return works without losing the Claude session.
- [ ] Dashboard is keyboard navigable and usable at 80, 120, and 160 columns.
- [ ] Dashboard viewing causes zero Claude and zero Codex model turns.
- [ ] One shared broker manages multiple bounded Codex lanes.
- [ ] Model, effort, status, phase, sandbox, capabilities, token usage, and evidence are truthful.
- [ ] Read-only and write-capable lanes are enforced independently.
- [ ] Cancellation, retry, and external effects are reconciled and confirmed safely.
- [ ] Existing editor/keybinding configuration is preserved and restored on uninstall.
- [ ] Windows, macOS, and Linux CI and PTY handoff tests pass.
- [ ] Skill forward tests prove correct delegation, capability gates, and verifier separation.
- [ ] Installation, upgrade, rollback, and uninstall are documented and verified.
- [ ] Open-source licensing and upstream notices are complete.

## 14. Evidence status at design approval

- `PROVEN`: Windows same-PTY external-editor entry and return on Claude Code v2.1.233.
- `INSPECTED`: the official OpenAI plugin's app-server, broker, job-control, state, command, test,
  and fake-server structure as the intended upstream runtime foundation.
- `DESIGNED`: fleet policy, dashboard interaction model, security boundaries, and recovery model.
- `UNPROVEN RELEASE GATES`: production raw-TTY navigation, mouse support, full draft preservation,
  performance budgets, packaged install/uninstall, and macOS/Linux PTY behavior.
