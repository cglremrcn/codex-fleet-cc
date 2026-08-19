# Live Control Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship cross-process Fleet Console follow-up/cancel, full cross-platform handoff evidence,
and a real-account Codex smoke before merging the release branch.

**Architecture:** A workspace-scoped Fleet supervisor owns the scheduler and one Codex app-server.
Authenticated local IPC connects CLI and TUI clients; persisted state is metadata-only and all
mutations are re-authorized by the supervisor.

**Tech Stack:** Node.js 22.20+, ESM, `node:net` named pipes/Unix sockets, Codex app-server JSON-RPC,
Claude Code plugin skills, `node:test`, `node-pty`, GitHub Actions.

**Spec:** `docs/specs/2026-08-19-live-control-release-design.md`

## Global Constraints

- No Python or `uv`; runtime and verification stay Node-only.
- No prompt, reasoning, credential, cookie or raw tool-output persistence.
- No shell command construction from user input.
- Cancellation requires thread/turn ownership and explicit target-pinned confirmation.
- One writer per workspace state; all state writes stay atomic and bounded.
- Windows, macOS Intel/ARM and Linux x64/ARM run Node 22.23.1 and 24.18.0 gates.

---

### Task 1: Authenticated local supervisor protocol

**Files:**
- Create: `plugins/fleet/scripts/lib/supervisor-protocol.mjs`
- Create: `plugins/fleet/scripts/fleet-supervisor.mjs`
- Create: `tests/supervisor-protocol.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `supervisorAddress(options)`, `ensureSupervisor(options)`,
  `requestSupervisor(options, request)`, and `runSupervisor(options)`.
- Requests: `{schemaVersion:1, requestId, token, workspaceKey, method, params}`.
- Responses: `{schemaVersion:1, requestId, ok, result?, error?}`.

- [ ] Write tests that fail because the protocol module does not exist: a real local connection
      accepts the right workspace/token, rejects a wrong token and workspace, rejects messages over
      128 KiB, and two concurrent `ensureSupervisor` calls return one proven PID/address.
- [ ] Run `node --test tests/supervisor-protocol.test.mjs` and confirm module-not-found or missing
      export failures.
- [ ] Implement bounded JSONL framing, constant-time token comparison, private manifest/start lock,
      named-pipe/Unix-socket addressing and PID/start-identity stale-owner checks.
- [ ] Run the focused test and confirm every case passes with zero orphan processes.
- [ ] Commit with `feat: add authenticated fleet supervisor` and push.

### Task 2: Cross-process lane lifecycle

**Files:**
- Modify: `plugins/fleet/scripts/lib/runtime-adapter.mjs`
- Modify: `plugins/fleet/scripts/lib/scheduler.mjs`
- Modify: `plugins/fleet/scripts/lib/cli.mjs`
- Modify: `plugins/fleet/scripts/fleet-supervisor.mjs`
- Modify: `plugins/fleet/agents/codex-lane.md`
- Test: `tests/runtime-adapter.test.mjs`
- Test: `tests/scheduler.test.mjs`
- Test: `tests/cli.test.mjs`
- Create: `tests/live-controls.test.mjs`

**Interfaces:**
- Produces: `runtime.resumeLane(record, workspacePath, message)` and
  `scheduler.continue(id, message)`.
- Supervisor methods: `start`, `followUp`, `cancel`, `status`, `result`, `shutdown`.
- `cancel` params include `laneId`, `expectedThreadId`, `expectedTurnId`, and confirmation token.

- [ ] Write failing tests for background admission, completed-thread resume in a fresh client,
      running-turn cancellation from a second process, wrong-turn refusal and immutable cancel
      preview tokens.
- [ ] Run focused tests and verify each failure is caused by the current
      `supervisor control is not available` branch.
- [ ] Implement supervisor-owned scheduler hydration, sanitized authority/result persistence,
      background `start`, exact follow-up transitions and target-pinned cancel.
- [ ] Update the lane bridge to submit background work and poll read-only status/result until the
      lane reaches a terminal state; never invoke Codex directly.
- [ ] Run all four focused suites and confirm cross-process operations use one app-server and leave
      no owned processes.
- [ ] Commit with `feat: wire live lane controls` and push.

### Task 3: Fleet Console composer and controls

**Files:**
- Modify: `plugins/fleet/scripts/fleet-console.mjs`
- Modify: `plugins/fleet/scripts/lib/console-controller.mjs`
- Modify: `plugins/fleet/scripts/lib/tui-input.mjs`
- Modify: `plugins/fleet/scripts/lib/tui-render.mjs`
- Test: `tests/console-controller.test.mjs`
- Test: `tests/tui-input.test.mjs`
- Test: `tests/tui-render.test.mjs`

**Interfaces:**
- Console runtime: `followUp(lane, message)` and `cancel(lane, expectedIdentity)`.
- UI state adds `composer: null | {laneId, value}` and pinned cancellation identity.

- [ ] Write failing controller/input tests proving `m` enters composer mode, text does not trigger
      shortcuts, Enter submits bounded text, Escape discards it, and cancellation refuses a changed
      thread/turn target.
- [ ] Run the focused tests and confirm the missing composer/control-client behavior is the failure.
- [ ] Implement composer input/rendering and a supervisor client wired by `fleet-console.mjs`.
- [ ] Preserve the existing filter, original-editor handoff, reduced-motion and screen-reader modes.
- [ ] Run focused tests plus golden tests; update goldens only for reviewed intentional output.
- [ ] Commit with `feat: control lanes from fleet console` and push.

### Task 4: Full platform handoff and real-account smoke

**Files:**
- Modify: `scripts/run-pty-smoke.mjs`
- Modify: `tests/fixtures/fake-claude-editor-host.mjs`
- Modify: `tests/pty-console.test.mjs`
- Create: `scripts/run-live-smoke.mjs`
- Create: `tests/live-smoke-contract.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `runPtySmoke()` returns installed-launcher, draft, terminal, uninstall and orphan assertions on
  every platform.
- `runLiveSmoke()` requires `--confirm-live-account` and returns only sanitized status/evidence.

- [ ] Write failing PTY assertions requiring the setup-generated launcher and uninstall path on
      POSIX, then run the Windows focused test to preserve existing behavior.
- [ ] Replace the POSIX split smoke with the same installed-launcher host chain used on Windows.
- [ ] Add an opt-in live-smoke contract test proving confirmation is mandatory, workspace is
      disposable, lanes are read-only/ephemeral and output excludes prompts and credentials.
- [ ] Implement the real smoke: investigator reads a nonce fixture, follow-up reads the second
      nonce, independent verifier checks both, and a separate active lane is interrupted.
- [ ] Run the live smoke against the current `codex login status` ChatGPT session and retain only
      the sanitized JSON evidence artifact.
- [ ] Run the full five-runner Node 22/24 CI matrix.
- [ ] Commit with `test: prove live fleet control flow` and push.

### Task 5: Release truth and integration

**Files:**
- Modify: `README.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/specs/2026-08-19-live-control-release-design.md`

**Interfaces:**
- Produces public installation, operation, recovery and verified-support claims.

- [ ] Update documentation with the supervisor lifecycle, exact control guarantees, real-smoke
      scope and complete platform evidence; retain the marketplace-not-published statement.
- [ ] Run `npm run verify` and `node scripts/release-check.mjs --version 0.1.0`.
- [ ] Obtain an independent differential review and fix every release-blocking finding with a new
      failing regression test.
- [ ] Push the final SHA, wait for CI, CodeQL and dependency review, then create and merge a GitHub
      pull request into `main` without touching the dirty local main checkout.
- [ ] Verify remote `main` contains the merge and report the exact SHA and remaining marketplace
      publication step.
