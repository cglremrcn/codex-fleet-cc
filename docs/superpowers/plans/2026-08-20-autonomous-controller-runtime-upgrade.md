# Autonomous Controller and Runtime Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute
> this plan task-by-task. Do not delegate this plan; the controlling session reviews every RED/GREEN
> transition.

**Goal:** Ship Fleet v0.1.6 with a self-consistent Ctrl+G runtime, real Codex session control, visible
KITE motion, and a deterministic Claude-controlled autonomous recovery loop.

**Architecture:** Fleet appends a trusted execution envelope and requests a structured Codex outcome.
The runtime adapter owns a bounded same-thread recovery state machine; the scheduler persists only
sanitized outcome metadata and exposes controller attention to Claude/TUI. Setup gains an
ownership-verified upgrade path so marketplace and Ctrl+G runtime versions cannot silently diverge.

**Tech Stack:** Node.js 22 ESM, Codex app-server JSON-RPC, `node:test`, `node-pty`, Claude Code plugin
skills/hooks, filesystem-backed Fleet state.

**Spec:** `docs/decisions/2026-08-20-v0.1.6-autonomous-controller-and-runtime-upgrade.md`

## Global Constraints

- Claude Code is the controller; Codex lanes never broaden their own authority.
- Automatic continuation stays on the same lane, thread, workspace, checkout, model, effort, and
  authority and stops after two turns.
- External-effect uncertainty is never retried automatically.
- `complete` remains a worker claim; `verified` still requires an independent verifier.
- Existing terminal records and original editor settings remain recoverable and immutable on failed
  admission or upgrade.
- Desktop-only capabilities are reported absent unless a real lane smoke test finds them callable.
- Production edits follow RED → observed expected failure → minimal GREEN → regression verification.

---

### Task 1: Ownership-verified integration runtime upgrade

**Files:**
- Modify: `tests/setup.test.mjs`
- Modify: `tests/cli.test.mjs`
- Modify: `tests/docs-surface.test.mjs`
- Modify: `plugins/fleet/scripts/lib/setup.mjs`
- Modify: `plugins/fleet/scripts/lib/cli.mjs`
- Modify: `plugins/fleet/scripts/fleet-session-hook.mjs`
- Modify: `plugins/fleet/skills/setup/SKILL.md`
- Modify: `docs/TROUBLESHOOTING.md`

**Interfaces:**
- Produce an upgrade preview that distinguishes `fresh`, `current`, and `upgrade` modes.
- Upgrade only a manifest whose owned launcher/runtime/settings evidence still matches.
- Preserve `originalValues`, stage the new runtime, atomically switch the launcher, and persist the
  new version.
- SessionStart reports the exact installed/integration version drift to Claude.

- [ ] Write tests that install 0.1.0, preview 0.1.6, require an upgrade mode, preserve original editor
  values, and reject modified launcher/settings evidence.
- [ ] Run focused setup/CLI/docs tests and observe failures caused by missing upgrade behavior.
- [ ] Implement the minimal upgrade path and version-drift diagnostic.
- [ ] Run the focused tests and keep all pre-existing setup/uninstall tests green.

### Task 2: Real PTY session entry and truthful visible motion

**Files:**
- Modify: `scripts/run-pty-smoke.mjs`
- Modify: `tests/pty-console.test.mjs`
- Modify: `tests/console-controller.test.mjs`
- Modify: `tests/tui-render.test.mjs`
- Modify: `plugins/fleet/scripts/lib/console-controller.mjs`
- Modify: `plugins/fleet/scripts/lib/tui-render.mjs`
- Modify: `plugins/fleet/scripts/fleet-console.mjs`
- Modify: `tests/golden/*.txt`

**Interfaces:**
- PTY smoke creates a controlled persisted lane/session, sends Enter, observes `FLEET//CODEX SESSION`,
  sends a bounded same-thread message, returns with Ctrl+G, and exits to the fake Claude host.
- The console header exposes the loaded Fleet version.
- Motion visibly changes at 4 Hz for supported states; pause/reduced-motion labels are truthful.

- [ ] Extend the real PTY smoke and controller tests so current coverage fails because Enter is not
  exercised end-to-end and reduced-motion resume feedback is misleading.
- [ ] Add renderer tests requiring visibly distinct consecutive KITE frames and a loaded-version label.
- [ ] Run focused tests and record the expected RED failures.
- [ ] Implement only the event/session/version/motion behavior required by those tests.
- [ ] Run focused controller, renderer, input, and PTY tests to GREEN; update goldens mechanically.

### Task 3: Structured lane outcome protocol

**Files:**
- Create: `plugins/fleet/scripts/lib/lane-outcome.mjs`
- Create: `tests/lane-outcome.test.mjs`
- Modify: `plugins/fleet/scripts/lib/runtime-adapter.mjs`
- Modify: `tests/runtime-adapter.test.mjs`
- Modify: `tests/upstream/fake-codex-fixture.mjs`
- Modify: `plugins/fleet/scripts/lib/safe-state.mjs`
- Modify: `tests/safe-state.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Export a frozen JSON schema, execution-envelope builder, bounded result parser, and recovery decision.
- Runtime starts every turn with the schema and stores sanitized outcome fields only.
- Malformed output is incomplete; it never maps directly to successful completion.

- [ ] Write pure parser/decision tests for all four outcomes, malformed JSON, overlong metadata,
  forbidden artifact paths, and controller-request kinds.
- [ ] Write runtime integration tests proving `outputSchema` and the execution envelope reach the
  fake app-server.
- [ ] Run the new tests and observe missing-module/`outputSchema: null` RED failures.
- [ ] Implement the minimal outcome module and runtime wiring.
- [ ] Run parser, runtime, redaction, and safe-state tests to GREEN.

### Task 4: Bounded same-thread automatic recovery

**Files:**
- Modify: `plugins/fleet/scripts/lib/runtime-adapter.mjs`
- Modify: `plugins/fleet/scripts/lib/scheduler.mjs`
- Modify: `plugins/fleet/scripts/lib/domain.mjs`
- Modify: `plugins/fleet/scripts/fleet-supervisor.mjs`
- Modify: `tests/runtime-adapter.test.mjs`
- Modify: `tests/scheduler.test.mjs`
- Modify: `tests/live-controls.test.mjs`
- Modify: `tests/e2e-fleet.test.mjs`

**Interfaces:**
- `continue_within_authority` and redundant approval start a new turn on the existing thread.
- Recovery fields are `autoContinuationCount`, `maxAutoContinuations`, `outcome`,
  `controllerRequest`, `artifactRefs`, and `verification`.
- New authority/choice/input requests become `blocked` with phase `needs-controller` and remain
  resumable by Claude; exhaustion does the same.

- [ ] Write tests for exact same-thread identity, distinct turn IDs, two-turn maximum, no authority
  widening, controller handoff, malformed-result repair, and preservation of the last terminal record
  when a continuation start is rejected.
- [ ] Run focused runtime/scheduler/live-control tests and observe RED failures.
- [ ] Implement the state machine without keyword-only success inference or blind retry.
- [ ] Run the focused tests to GREEN and verify duplicate-ID and single-writer regressions remain green.

### Task 5: Claude controller bridge, templates, and operator surfaces

**Files:**
- Modify: `plugins/fleet/scripts/lib/contract-templates.mjs`
- Modify: `plugins/fleet/agents/codex-lane.md`
- Modify: `plugins/fleet/skills/codex-fleet-orchestrator/SKILL.md`
- Modify: `plugins/fleet/skills/codex-fleet-orchestrator/references/contracts.md`
- Modify: `plugins/fleet/scripts/lib/tui-render.mjs`
- Modify: `plugins/fleet/scripts/lib/plain-status.mjs`
- Modify: `tests/skill-contract.test.mjs`
- Modify: `tests/plugin-contract.test.mjs`
- Modify: `tests/plain-status.test.mjs`
- Modify: `tests/tui-render.test.mjs`

**Interfaces:**
- Required prompt section 10 is `Execution posture` and every maintained template supplies it.
- The bridge waits through internal recovery and returns either accomplished evidence or an exact
  controller request to Claude.
- TUI/plain status show `RECOVERING n/2` and `BLOCKED / CLAUDE ACTION` without claiming verification.

- [ ] Encode the observed Stripe/motion plan-only failure as behavioral fixture cases and add template,
  bridge, plain-status, and renderer regressions.
- [ ] Run the focused tests and observe RED failures.
- [ ] Add the minimal skill/template/bridge instructions and operator rendering.
- [ ] Run skill evals plus focused plugin/status/TUI tests to GREEN; manually inspect every flagged
  plan-only/controller case.

### Task 6: Release, live upgrade, and end-to-end acceptance

**Files:**
- Modify: `package.json`
- Modify: `plugins/fleet/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: release artifacts generated by existing scripts

**Interfaces:**
- All version surfaces become `0.1.6`.
- Release scripts package and validate the same version.
- The local Claude marketplace cache and Ctrl+G integration ownership both report 0.1.6.

- [ ] Run `npm run typecheck`, the full test suite, strict plugin validation, secrets, licenses,
  performance, docs, package, and release checks.
- [ ] Apply the ownership-verified local integration upgrade and run the real PTY smoke against the
  installed launcher.
- [ ] Run one safe live lane that proves structured outcome, immediate Claude return, same-thread
  automatic recovery, and image capability reporting without external mutation.
- [ ] Compare source, marketplace cache, and integration runtime after line-ending normalization.
- [ ] Review `git diff`, update project memory with the stale-runtime root cause and recovery rule,
  commit with a concise conventional message, push `main`, reinstall/update the marketplace plugin,
  and verify the remote commit.
