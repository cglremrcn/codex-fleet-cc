# Codex Fleet for Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, local-first Claude Code plugin that delegates bounded work to Codex,
manages a small fleet through one broker, and exposes a fast same-terminal operator console.

**Architecture:** The Apache-2.0 OpenAI Claude Code plugin supplies the proven Codex app-server
foundation behind a narrow adapter. A zero-runtime-dependency Node.js core owns lane contracts,
authority, state, scheduling, and rendering. Claude uses a progressive-disclosure orchestration
skill; the user opens the console through Claude's supported external-editor handoff.

**Tech Stack:** Node.js 18.18+, ECMAScript modules with JSDoc type checking, Node's built-in test
runner, Codex app-server JSON-RPC, Claude Code plugins and skills, ANSI/VT terminal rendering,
GitHub Actions.

**Spec:** `docs/specs/2026-08-17-codex-fleet-cc-design.md`

## Global Constraints

- Runtime dependencies: zero unless a measured, reviewed exception is added.
- Default maximum active lanes: 3; default writers per checkout: 1.
- One local Codex app-server broker is shared by compatible lanes.
- Dashboard refresh is event-driven and never exceeds four redraws per second.
- Dashboard viewing starts no Claude or Codex model turn.
- No TCP listener, telemetry, prompt persistence, raw reasoning persistence, or secret persistence.
- State-changing controls require authority checks; unknown external outcomes are never retried.
- Plugin data lives outside the repository and survives plugin version updates.
- User settings are structurally merged, backed up, and restored only when ownership still matches.
- Windows, macOS, and Linux support is a release claim only after their CI and PTY gates pass.
- Upstream Apache-2.0 `LICENSE`, `NOTICE`, attribution, and modified-file notices are retained.
- The project is described as independent and is never presented as endorsed by OpenAI or
  Anthropic.
- Every behavior follows RED–GREEN–REFACTOR and every task ends with a focused commit.

## Planned file map

```text
.
├── .claude-plugin/marketplace.json       # installable marketplace catalog
├── .github/                              # CI, issue forms, dependency and release automation
├── docs/                                 # architecture, threat model, support and contribution docs
├── plugins/fleet/
│   ├── .claude-plugin/plugin.json        # Claude plugin identity
│   ├── agents/codex-lane.md              # native Claude subagent wrapper around one Codex lane
│   ├── hooks/hooks.json                  # session lifecycle and safe runtime synchronization
│   ├── skills/                           # setup, doctor, status, controls and orchestrator
│   └── scripts/
│       ├── fleet.mjs                     # deterministic CLI entry point
│       ├── fleet-console.mjs             # same-terminal dashboard entry point
│       ├── app-server-broker.mjs         # single owned Codex broker entry point
│       ├── fleet-session-hook.mjs        # session/runtime reconciliation
│       └── lib/
│           ├── domain.mjs                # lane and authority types/state transitions
│           ├── authority.mjs             # capability and side-effect policy
│           ├── paths.mjs                 # platform data paths and canonical workspace keys
│           ├── safe-state.mjs            # atomic bounded persistence and locking
│           ├── redaction.mjs             # display/persistence sanitization
│           ├── runtime-adapter.mjs       # stable Codex operations
│           ├── scheduler.mjs             # resource governor and writer serialization
│           ├── setup.mjs                 # reversible editor handoff installation
│           ├── tui-input.mjs             # keyboard and SGR mouse decoding
│           ├── tui-render.mjs            # pure responsive screen renderer
│           ├── tui-session.mjs           # raw terminal lifecycle and crash restoration
│           └── upstream/                 # attributed OpenAI runtime foundation
├── tests/                                # unit, integration, golden, PTY and contract tests
├── LICENSE
├── NOTICE
├── README.md
├── SECURITY.md
├── package.json
└── package-lock.json
```

---

### Task 1: Reproducible foundation and upstream provenance

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `plugins/fleet/LICENSE`
- Create: `plugins/fleet/NOTICE`
- Create: `docs/UPSTREAM.md`
- Create: `tests/provenance.test.mjs`
- Create: `tests/helpers.mjs`
- Create: `tests/upstream/`
- Create: `plugins/fleet/scripts/lib/upstream/`

**Interfaces:**
- Consumes: upstream `openai/codex-plugin-cc` commit
  `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Produces: `UPSTREAM_COMMIT`, `UPSTREAM_FILES`, and a testable attribution boundary.

- [ ] **Step 1: Write the failing provenance test**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("derived runtime records its exact Apache-2.0 origin", () => {
  const upstream = fs.readFileSync(new URL("../docs/UPSTREAM.md", import.meta.url), "utf8");
  const notice = fs.readFileSync(new URL("../NOTICE", import.meta.url), "utf8");
  const pluginNotice = fs.readFileSync(
    new URL("../plugins/fleet/NOTICE", import.meta.url),
    "utf8"
  );
  assert.match(upstream, /db52e28f4d9ded852ab3942cea316258ae4ef346/);
  assert.match(upstream, /plugins\/fleet\/scripts\/lib\/upstream/);
  assert.match(notice, /Copyright 2026 OpenAI/);
  assert.match(notice, /modified by the Codex Fleet contributors/i);
  assert.equal(pluginNotice, notice);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/provenance.test.mjs`

Expected: FAIL because `docs/UPSTREAM.md`, `NOTICE`, and the derived runtime do not exist.

- [ ] **Step 3: Add the package contract and exact upstream material**

Use package name `codex-fleet-cc`, version `0.1.0`, `type: module`, Node engine
`>=18.18.0`, Apache-2.0 license, and scripts `test`, `test:unit`, `test:integration`,
`test:pty`, `typecheck`, `validate:plugin`, and `verify`. Copy the exact Apache license and
OpenAI notice. Copy the selected upstream runtime modules and their matching tests into the
dedicated `upstream` directories, adjust only paths and the client identity required by the new
plugin layout, and list every copied source path plus its exact/modified status in
`docs/UPSTREAM.md`. Put shared project test utilities in `tests/helpers.mjs`.

- [ ] **Step 4: Run the focused test and package audit**

Run: `node --test tests/provenance.test.mjs`

Expected: PASS.

Run: `npm install --package-lock-only --ignore-scripts`

Expected: a deterministic lockfile with no runtime dependency.

- [ ] **Step 5: Commit**

```bash
git add LICENSE NOTICE plugins/fleet/LICENSE plugins/fleet/NOTICE docs/UPSTREAM.md package.json package-lock.json tests/provenance.test.mjs tests/helpers.mjs tests/upstream plugins/fleet/scripts/lib/upstream
git commit -m "chore: establish licensed runtime foundation"
```

### Task 2: Lane domain model and truthful state machine

**Files:**
- Create: `plugins/fleet/scripts/lib/domain.mjs`
- Create: `tests/domain.test.mjs`

**Interfaces:**
- Produces: `LANE_STATUSES`, `TERMINAL_STATUSES`, `createLane(input)`,
  `transitionLane(lane, nextStatus, evidence)`, and `isTerminalStatus(status)`.
- `createLane` accepts `{ id, role, label, workspaceKey, model, effort, authority }`.
- `transitionLane` returns a new frozen lane and never mutates its input.

- [ ] **Step 1: Write failing transition tests**

```js
test("complete remains a claim until independent evidence verifies it", () => {
  const lane = createLane(fixtureLane());
  const running = transitionLane(lane, "running", { at: NOW });
  const complete = transitionLane(running, "complete", { at: NOW, resultRef: "result.json" });
  assert.equal(complete.status, "complete");
  assert.throws(() => transitionLane(complete, "verified", { at: NOW }), /verification evidence/i);
});

test("unknown external outcome cannot transition to queued retry", () => {
  const running = transitionLane(createLane(fixtureLane()), "running", { at: NOW });
  const lane = transitionLane(running, "outcome_unknown", {
    at: NOW,
    externalEffect: true
  });
  assert.throws(() => transitionLane(lane, "queued", { at: NOW }), /reconciliation/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/domain.test.mjs`

Expected: FAIL with missing module or export errors.

- [ ] **Step 3: Implement the immutable state machine**

Allowed statuses are `queued`, `running`, `complete`, `verified`, `blocked`, `failed`,
`cancelled`, and `outcome_unknown`. Encode an explicit transition table. Require a non-empty
`verifierLaneId` and `evidenceRefs` array for `complete -> verified`; require
`reconciliationRef` for `outcome_unknown -> queued`.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/domain.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/domain.mjs tests/domain.test.mjs
git commit -m "feat: add truthful lane state machine"
```

### Task 3: Authority and capability policy

**Files:**
- Create: `plugins/fleet/scripts/lib/authority.mjs`
- Create: `tests/authority.test.mjs`

**Interfaces:**
- Consumes: lane authority from `domain.mjs`.
- Produces: `normalizeAuthority(input)`, `authorizeAction(authority, action, context)`, and
  `requiresConfirmation(action)`.
- Authorization returns `{ allowed, reason, confirmationRequired }`; it never throws for denial.

- [ ] **Step 1: Write failing policy tests**

```js
test("read-only investigator cannot edit or deploy", () => {
  const authority = normalizeAuthority({ sandbox: "read-only", network: "off" });
  assert.equal(authorizeAction(authority, "filesystem.write", {}).allowed, false);
  assert.equal(authorizeAction(authority, "deploy.production", {}).allowed, false);
});

test("browser discovery is not browser account mutation authority", () => {
  const authority = normalizeAuthority({ browser: { inspect: true, mutate: false } });
  assert.equal(authorizeAction(authority, "browser.inspect", {}).allowed, true);
  assert.equal(authorizeAction(authority, "browser.submit", {}).allowed, false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/authority.test.mjs`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement fail-closed policy**

Define actions for filesystem read/write, live web, browser inspect/mutate, process start/stop,
database read/write, send, payment, deploy, delete, and retry. Unknown actions deny. All external
mutations, write escalation, cancellation, and retries after uncertain outcomes require an
explicit confirmation token bound to the action and lane.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/authority.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/authority.mjs tests/authority.test.mjs
git commit -m "feat: enforce fleet authority boundaries"
```

### Task 4: Redaction, bounded state, and platform-safe paths

**Files:**
- Create: `plugins/fleet/scripts/lib/redaction.mjs`
- Create: `plugins/fleet/scripts/lib/paths.mjs`
- Create: `plugins/fleet/scripts/lib/safe-state.mjs`
- Create: `tests/redaction.test.mjs`
- Create: `tests/paths.test.mjs`
- Create: `tests/safe-state.test.mjs`

**Interfaces:**
- Produces: `redactText(text)`, `sanitizeLaneForPersistence(lane)`, `getFleetDataDir(env,
  platform, home)`, `workspaceKey(path)`, `readWorkspaceState(root)`, and
  `writeWorkspaceState(root, state)`.
- Persisted state is schema-versioned, capped at 256 lanes and 2 MiB per workspace file.

- [ ] **Step 1: Write hostile-input tests**

```js
test("redaction removes common credentials and personal addresses", () => {
  const value = redactText("Bearer abc.def.ghi user@example.com sk-live-secret");
  assert.doesNotMatch(value, /abc\.def\.ghi|user@example\.com|sk-live-secret/);
  assert.match(value, /\[REDACTED:/);
});

test("workspace keys do not expose canonical paths", async () => {
  const key = await workspaceKey("C:\\Users\\Ada\\private-client");
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(key, /Ada|private-client/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/redaction.test.mjs tests/paths.test.mjs tests/safe-state.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement platform adapters and atomic writes**

Use `%LOCALAPPDATA%/codex-fleet-cc` on Windows,
`~/Library/Application Support/codex-fleet-cc` on macOS, and
`${XDG_STATE_HOME}/codex-fleet-cc` or `~/.local/state/codex-fleet-cc` on Linux. Canonicalize and
hash workspaces with SHA-256 truncated to 32 hex characters. Write a same-directory temporary
file with exclusive creation, flush, close, then atomic rename. Reject symlinks, oversized input,
unknown schema versions, and paths outside the owned data root.

- [ ] **Step 4: Verify permission and corruption behavior**

Run: `node --test tests/redaction.test.mjs tests/paths.test.mjs tests/safe-state.test.mjs`

Expected: PASS, including Windows rename retry and corrupt-file quarantine fixtures.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/redaction.mjs plugins/fleet/scripts/lib/paths.mjs plugins/fleet/scripts/lib/safe-state.mjs tests/redaction.test.mjs tests/paths.test.mjs tests/safe-state.test.mjs
git commit -m "feat: add private atomic fleet state"
```

### Task 5: Stable Codex runtime adapter

**Files:**
- Create: `plugins/fleet/scripts/lib/runtime-adapter.mjs`
- Create: `plugins/fleet/scripts/app-server-broker.mjs`
- Create: `tests/runtime-adapter.test.mjs`
- Create: `tests/fixtures/fake-codex-app-server.mjs`

**Interfaces:**
- Consumes: attributed upstream app-server client and job-control helpers.
- Produces: `createRuntime(options)` with methods `startLane(contract)`, `continueLane(id,
  message)`, `interruptLane(id)`, `inspectLane(id)`, `listLanes(workspace)`, and `close()`.
- Runtime events are normalized to `{ laneId, sequence, at, type, payload }`.

- [ ] **Step 1: Write a failing adapter contract test**

```js
test("one adapter reuses one broker for two read-only lanes", async (t) => {
  const fixture = await startFakeCodex(t);
  const runtime = await createRuntime({ codexCommand: fixture.command, dataDir: fixture.dataDir });
  await runtime.startLane(readOnlyContract("lane-a"));
  await runtime.startLane(readOnlyContract("lane-b"));
  assert.equal(fixture.appServerStarts(), 1);
  await runtime.close();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/runtime-adapter.test.mjs`

Expected: FAIL because `createRuntime` is missing.

- [ ] **Step 3: Implement the narrow adapter**

Wrap upstream JSON-RPC details and expose only the six public methods. Spawn with argument arrays,
never interpolate lane input into a shell command, and resolve the Codex executable before spawn.
Map app-server notifications to monotonically sequenced events. Keep raw reasoning deltas opted
out. A broker protocol/version mismatch blocks write methods but may leave read-only inspection.

- [ ] **Step 4: Run focused and ported upstream compatibility tests**

The preserved upstream `runtime.test.mjs` targets command and hook entry points that Fleet does not
ship. Keep that file byte-for-byte as a provenance reference and run the narrow port that exercises
the inherited broker endpoint contract against Fleet's isolated directory instead.

Run: `node --test tests/runtime-adapter.test.mjs tests/upstream-runtime-compat.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/runtime-adapter.mjs plugins/fleet/scripts/app-server-broker.mjs tests/runtime-adapter.test.mjs tests/fixtures/fake-codex-app-server.mjs
git commit -m "feat: add stable Codex runtime adapter"
```

### Task 6: Resource governor and lane scheduler

**Files:**
- Create: `plugins/fleet/scripts/lib/scheduler.mjs`
- Create: `tests/scheduler.test.mjs`

**Interfaces:**
- Consumes: normalized contracts, authority, runtime adapter, and state store.
- Produces: `createScheduler({ runtime, store, limits, clock })` with `enqueue`, `cancel`,
  `reconcile`, and `snapshot`.

- [ ] **Step 1: Write failing concurrency tests**

```js
test("scheduler caps active lanes and serializes writers per checkout", async () => {
  const runtime = recordingRuntime();
  const scheduler = createScheduler(harness({ runtime, maxActive: 3, maxWritersPerCheckout: 1 }));
  await Promise.all([
    scheduler.enqueue(writer("a", "checkout-1")),
    scheduler.enqueue(writer("b", "checkout-1")),
    scheduler.enqueue(reader("c", "checkout-1")),
    scheduler.enqueue(reader("d", "checkout-2"))
  ]);
  assert.equal(runtime.maxConcurrent(), 3);
  assert.equal(runtime.maxWriters("checkout-1"), 1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/scheduler.test.mjs`

Expected: FAIL because the scheduler is missing.

- [ ] **Step 3: Implement fair bounded scheduling**

Use FIFO within priority bands, stagger starts by 150 ms, reserve no hidden lane, and prevent a
continuous reader stream from starving a queued writer. Cancellation targets only a recorded
owned process/thread. Reconciliation runs before retry and persists `outcome_unknown` when an
external effect cannot be determined.

- [ ] **Step 4: Run deterministic clock tests**

Run: `node --test tests/scheduler.test.mjs`

Expected: PASS with no real sleeps.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/scheduler.mjs tests/scheduler.test.mjs
git commit -m "feat: govern fleet concurrency"
```

### Task 7: Deterministic Fleet CLI

**Files:**
- Create: `plugins/fleet/scripts/fleet.mjs`
- Create: `plugins/fleet/scripts/lib/cli.mjs`
- Create: `tests/cli.test.mjs`

**Interfaces:**
- Produces commands `doctor`, `start`, `status`, `result`, `follow-up`, `cancel`, `export`,
  `setup`, and `uninstall`.
- Structured commands accept a UTF-8 JSON contract file or stdin, never executable prompt text.
- `--json` writes one JSON object to stdout; diagnostics go to stderr.

- [ ] **Step 1: Write failing CLI process tests**

```js
test("status is read-only and emits machine JSON", async () => {
  const run = await runFleet(["status", "--json"], fixtureEnv());
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(run.stdout).schemaVersion, 1);
  assert.deepEqual(await fixtureRepoChanges(), []);
});

test("start rejects inline shell-bearing task input", async () => {
  const run = await runFleet(["start", "$(touch pwned)"], fixtureEnv());
  assert.equal(run.code, 2);
  assert.match(run.stderr, /contract file or stdin/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/cli.test.mjs`

Expected: FAIL because the CLI entry point is missing.

- [ ] **Step 3: Implement strict parsing and exit codes**

Use exit code `0` for success, `2` for invalid input, `3` for denied authority, `4` for runtime
unavailable, and `5` for outcome unknown. Cap JSON contract input at 128 KiB. Reject duplicate
flags, unexpected positional input, unknown properties, and non-UTF-8 files.

- [ ] **Step 4: Run CLI tests**

Run: `node --test tests/cli.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/fleet.mjs plugins/fleet/scripts/lib/cli.mjs tests/cli.test.mjs
git commit -m "feat: add deterministic fleet CLI"
```

### Task 8: Reversible Claude external-editor setup

**Files:**
- Create: `plugins/fleet/scripts/lib/setup.mjs`
- Create: `plugins/fleet/scripts/launchers/fleet-editor.cmd`
- Create: `plugins/fleet/scripts/launchers/fleet-editor.sh`
- Create: `tests/setup.test.mjs`

**Interfaces:**
- Produces: `previewSetup(options)`, `applySetup(plan)`, and `uninstallSetup(options)`.
- Setup owns only `env.EDITOR`, `env.VISUAL`, its stable plugin-data runtime copy, and an
  ownership manifest containing hashes of values it wrote.

- [ ] **Step 1: Write failing structural-merge tests**

```js
test("setup preserves unrelated settings and the previous editor", async () => {
  await writeSettings({ permissions: { deny: ["Read(.env)"] }, env: { EDITOR: "nvim" } });
  const plan = await previewSetup(fixtureSetup());
  await applySetup({ ...plan, confirmation: plan.confirmationToken });
  const settings = await readSettings();
  assert.deepEqual(settings.permissions.deny, ["Read(.env)"]);
  assert.equal(await storedOriginalEditor(), "nvim");
});

test("uninstall refuses to overwrite an editor changed after setup", async () => {
  await installFixture();
  await setCurrentEditor("code --wait");
  await assert.rejects(uninstallSetup(fixtureSetup()), /no longer owned/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/setup.test.mjs`

Expected: FAIL because setup is missing.

- [ ] **Step 3: Implement preview, backup, apply, and ownership-aware uninstall**

Copy the versioned runtime into the stable Claude plugin data directory, create the correct
launcher for the platform, show an exact settings diff, and require the preview token to apply.
Use a unique backup filename and atomic settings replace. Never modify keybindings for the default
`Ctrl+G`; optional custom binding changes receive the same preview/ownership treatment. State that
a Claude restart may be required for environment changes.

- [ ] **Step 4: Run setup tests on platform fixtures**

Run: `node --test tests/setup.test.mjs`

Expected: PASS for Windows, macOS, and Linux path fixtures.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/setup.mjs plugins/fleet/scripts/launchers tests/setup.test.mjs
git commit -m "feat: add reversible Claude handoff setup"
```

### Task 9: Pure Bloomberg-inspired responsive renderer

**Files:**
- Create: `plugins/fleet/scripts/lib/tui-render.mjs`
- Create: `plugins/fleet/scripts/lib/theme.mjs`
- Create: `tests/tui-render.test.mjs`
- Create: `tests/golden/wide.txt`
- Create: `tests/golden/compact.txt`
- Create: `tests/golden/narrow.txt`
- Create: `tests/golden/mono.txt`
- Create: `scripts/update-goldens.mjs`

**Interfaces:**
- Produces: `renderScreen(viewModel, terminal, preferences): string`,
  `buildViewModel(snapshot, selection, panel): FleetViewModel`, and
  `displayWidth(value): number`.
- Renderer is pure: no clock, filesystem, environment, or terminal writes.

- [ ] **Step 1: Write failing layout and truthfulness tests**

```js
for (const [name, columns] of [["wide", 160], ["compact", 100], ["narrow", 72]]) {
  test(`${name} layout stays inside the viewport`, () => {
    const output = stripAnsi(renderScreen(fleetViewFixture(), { columns, rows: 28 }, colorPrefs()));
    assert.ok(output.split("\n").every((line) => displayWidth(line) <= columns));
  });
}

test("renderer never invents token or verification data", () => {
  const output = renderScreen(fleetViewFixture({ tokenUsage: null, status: "complete" }),
    { columns: 120, rows: 30 }, colorPrefs());
  assert.doesNotMatch(output, /0 tokens|verified/i);
  assert.match(output, /COMPLETE/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/tui-render.test.mjs`

Expected: FAIL because renderer and goldens are missing.

- [ ] **Step 3: Implement the visual system**

Use graphite/near-black surfaces, cyan selection, amber active work, green only for verified, and
red only for denied/failed states. Use hard alignment, one-cell separators, concise labels, no
gradient, and no animation. Implement wide (three regions), compact (two regions plus tabs), and
narrow (single panel) layouts. Add `NO_COLOR`, monochrome, Unicode-width-safe truncation, and ASCII
borders.

- [ ] **Step 4: Review and accept deterministic goldens**

Run: `node scripts/update-goldens.mjs`

Inspect all four generated text files at 100% zoom, then run without update:

Run: `node --test tests/tui-render.test.mjs`

Expected: PASS with stable goldens.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/tui-render.mjs plugins/fleet/scripts/lib/theme.mjs scripts/update-goldens.mjs tests/tui-render.test.mjs tests/golden
git commit -m "feat: render responsive fleet console"
```

### Task 10: Keyboard, mouse, and terminal lifecycle

**Files:**
- Create: `plugins/fleet/scripts/lib/tui-input.mjs`
- Create: `plugins/fleet/scripts/lib/tui-session.mjs`
- Create: `tests/tui-input.test.mjs`
- Create: `tests/tui-session.test.mjs`

**Interfaces:**
- Produces: `createInputDecoder()`, `reduceInput(state, event)`, and
  `withTerminalSession(io, run)`.
- Terminal session always restores raw mode, cursor, mouse tracking, and alternate screen.

- [ ] **Step 1: Write failing fragmented-sequence and restoration tests**

```js
test("decoder handles arrow and SGR mouse sequences split across chunks", () => {
  const decoder = createInputDecoder();
  assert.deepEqual(decoder.push(Buffer.from("\u001b[")), []);
  assert.deepEqual(decoder.push(Buffer.from("B")), [{ type: "move", delta: 1 }]);
  assert.deepEqual(decoder.push(Buffer.from("\u001b[<0;12;5M")),
    [{ type: "mouseDown", button: 0, column: 12, row: 5 }]);
});

test("terminal restores modes when the dashboard throws", async () => {
  const io = fakeTerminal();
  await assert.rejects(withTerminalSession(io, async () => { throw new Error("boom"); }));
  assert.equal(io.rawMode, false);
  assert.match(io.output(), /\u001b\[\?1049l/);
  assert.match(io.output(), /\u001b\[\?25h/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/tui-input.test.mjs tests/tui-session.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement a bounded parser and restoration guard**

Decode arrows, `j/k`, Enter, Tab, Shift+Tab, `/`, `?`, `e`, `m`, `x`, `r`, `c`, `q`, Escape,
resize, and SGR mouse press/release/wheel. Bound incomplete escape buffers to 64 bytes. Register
handlers for normal return, thrown error, `SIGINT`, `SIGTERM`, and process exit; make restoration
idempotent.

- [ ] **Step 4: Run input/session tests**

Run: `node --test tests/tui-input.test.mjs tests/tui-session.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/tui-input.mjs plugins/fleet/scripts/lib/tui-session.mjs tests/tui-input.test.mjs tests/tui-session.test.mjs
git commit -m "feat: add safe terminal controls"
```

### Task 11: Interactive Fleet Console

**Files:**
- Create: `plugins/fleet/scripts/fleet-console.mjs`
- Create: `plugins/fleet/scripts/lib/console-controller.mjs`
- Create: `tests/console-controller.test.mjs`
- Create: `tests/fleet-console.test.mjs`

**Interfaces:**
- Consumes: state, renderer, input, authority, CLI controls, and the opaque Claude draft path.
- Produces: `runConsole({ cwd, draftPath, io, clock, spawnEditor })`.

- [ ] **Step 1: Write failing controller tests**

```js
test("viewing and navigation never invoke a model operation", async () => {
  const runtime = recordingRuntime();
  await runConsole(consoleHarness({ runtime, input: ["down", "tab", "q"] }));
  assert.deepEqual(runtime.calls, []);
});

test("opening the preserved editor passes the untouched Claude draft", async () => {
  const draft = await createDraft("keep this prompt");
  const editor = recordingEditor();
  await runConsole(consoleHarness({ draftPath: draft, spawnEditor: editor, input: ["e", "q"] }));
  assert.deepEqual(editor.args, [draft]);
  assert.equal(await readDraft(draft), "keep this prompt");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/console-controller.test.mjs tests/fleet-console.test.mjs`

Expected: FAIL because console entry points are missing.

- [ ] **Step 3: Implement event-driven console control**

Read state on change notification or a 250 ms maximum fallback tick. Redraw only when the view
hash changes. Implement filtering, panel focus, help, original editor handoff, bounded follow-up,
confirmed cancellation, safe retry, and OSC 52 identifier copy with a visible fallback. Disable
controls that fail authority or outcome reconciliation and show the exact reason.

- [ ] **Step 4: Run console tests and startup benchmark**

Run: `node --test tests/console-controller.test.mjs tests/fleet-console.test.mjs`

Expected: PASS.

Run: `node plugins/fleet/scripts/fleet-console.mjs --benchmark-startup --plain`

Expected: exit `0`, median startup under 150 ms on the Windows development machine, and no
background process after exit.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/fleet-console.mjs plugins/fleet/scripts/lib/console-controller.mjs tests/console-controller.test.mjs tests/fleet-console.test.mjs
git commit -m "feat: add interactive Fleet Console"
```

### Task 12: Claude plugin, skills, and Codex lane agent

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/fleet/.claude-plugin/plugin.json`
- Create: `plugins/fleet/agents/codex-lane.md`
- Create: `plugins/fleet/hooks/hooks.json`
- Create: `plugins/fleet/scripts/fleet-session-hook.mjs`
- Create: `plugins/fleet/skills/setup/SKILL.md`
- Create: `plugins/fleet/skills/doctor/SKILL.md`
- Create: `plugins/fleet/skills/status/SKILL.md`
- Create: `plugins/fleet/skills/open/SKILL.md`
- Create: `plugins/fleet/skills/cancel/SKILL.md`
- Create: `plugins/fleet/skills/result/SKILL.md`
- Create: `plugins/fleet/skills/export/SKILL.md`
- Create: `plugins/fleet/skills/uninstall/SKILL.md`
- Create: `tests/plugin-contract.test.mjs`

**Interfaces:**
- Produces namespace `/fleet:*` and agent `fleet:codex-lane`.
- The agent receives one immutable lane contract and calls only the deterministic Fleet CLI.

- [ ] **Step 1: Write failing manifest and prompt contract tests**

```js
test("plugin exposes the public command surface without project-specific content", async () => {
  const manifest = JSON.parse(await read("plugins/fleet/.claude-plugin/plugin.json"));
  assert.equal(manifest.name, "fleet");
  for (const name of ["setup", "doctor", "status", "open", "cancel", "result", "export", "uninstall"])
    assert.equal(await exists(`plugins/fleet/skills/${name}/SKILL.md`), true);
  const allText = await readTree("plugins/fleet");
  assert.doesNotMatch(allText, /startupai|bizaliriz|b2b-lead-automation/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/plugin-contract.test.mjs`

Expected: FAIL because the plugin files are missing.

- [ ] **Step 3: Implement the plugin surface**

Use `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PROJECT_DIR}` rather than
absolute paths. Mark user-only state-changing skills `disable-model-invocation: true` so Claude
cannot invoke them automatically; this flag is not described as making a user invocation free.
The session hook reconciles owned state and never starts a lane automatically.

- [ ] **Step 4: Validate with Claude Code**

Run: `claude plugin validate ./plugins/fleet --strict`

Expected: `Validation passed` with no warnings.

Run: `node --test tests/plugin-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin plugins/fleet/.claude-plugin plugins/fleet/agents plugins/fleet/hooks plugins/fleet/skills plugins/fleet/scripts/fleet-session-hook.mjs tests/plugin-contract.test.mjs
git commit -m "feat: package Fleet for Claude Code"
```

### Task 13: Progressive-disclosure fleet orchestrator skill

**Files:**
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/SKILL.md`
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/references/capability-routing.md`
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/references/contracts.md`
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/references/fleet-patterns.md`
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/references/evidence-and-verification.md`
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/references/browser-and-external-effects.md`
- Create: `plugins/fleet/skills/codex-fleet-orchestrator/references/recovery.md`
- Create: `tests/skill-contract.test.mjs`
- Create: `tests/fixtures/skill-cases.json`
- Create: `scripts/run-skill-evals.mjs`

**Interfaces:**
- Produces bounded lane contracts with objective, inputs, exclusions, authority, capability
  evidence, deliverable, verification, stop conditions, and cleanup.
- The skill chooses one lane by default and scales only for independent evidence surfaces.

- [ ] **Step 1: Write failing static and forward-test cases**

```js
test("orchestrator forbids authority by role and same-lane verification", async () => {
  const skill = await read("plugins/fleet/skills/codex-fleet-orchestrator/SKILL.md");
  assert.match(skill, /roles do not grant authority/i);
  assert.match(skill, /fresh.*verifier/i);
  assert.match(skill, /capability discovery.*smoke/i);
});
```

The fixture cases must cover atomic code review, live web research, browser QA with an existing
session, one shared-checkout writer, two isolated worktree writers, unknown external outcome, and
an unavailable capability.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/skill-contract.test.mjs`

Expected: FAIL because the skill is missing.

- [ ] **Step 3: Write the concise entry skill and routed references**

Keep `SKILL.md` under 350 lines. Put operational detail in references and state exactly when each
reference is read. Require existence checks before “missing” claims, hypothesis/refutation for
diagnosis, class-wide sibling searches after root cause, environment-specific verification, and
evidence-first reporting.

- [ ] **Step 4: Run static tests and fresh-context forward evaluations**

Run: `node --test tests/skill-contract.test.mjs`

Expected: PASS.

Run: `node scripts/run-skill-evals.mjs --plugin ./plugins/fleet`

Expected: each JSON fixture runs in a fresh Claude context; only scored, sanitized outcomes are
saved under `tests/artifacts/skill-eval/`. Every safety-critical case passes and routing accuracy
is at least 90% overall.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/skills/codex-fleet-orchestrator scripts/run-skill-evals.mjs tests/skill-contract.test.mjs tests/fixtures/skill-cases.json tests/artifacts/skill-eval
git commit -m "feat: add Codex fleet orchestration skill"
```

### Task 14: Doctor, support bundle, and accessibility surfaces

**Files:**
- Create: `plugins/fleet/scripts/lib/doctor.mjs`
- Create: `plugins/fleet/scripts/lib/support-bundle.mjs`
- Create: `plugins/fleet/scripts/lib/plain-status.mjs`
- Create: `tests/doctor.test.mjs`
- Create: `tests/support-bundle.test.mjs`
- Create: `tests/plain-status.test.mjs`

**Interfaces:**
- Produces: `runDoctor(options)`, `previewSupportBundle(options)`,
  `writeSupportBundle(preview, confirmation)`, and `renderPlainStatus(snapshot)`.
- Capability results distinguish `available`, `configured`, `smoke_passed`, `denied`, and
  `unknown`.

- [ ] **Step 1: Write failing diagnostic privacy tests**

```js
test("support preview contains no prompt, token, cookie, or canonical private path", async () => {
  const preview = await previewSupportBundle(secretFixture());
  const serialized = JSON.stringify(preview);
  assert.doesNotMatch(serialized, /secret prompt|Bearer |session_cookie|Users\\Ada/);
});

test("plain status is linear and free of cursor-control codes", () => {
  const output = renderPlainStatus(fleetSnapshot());
  assert.doesNotMatch(output, /\u001b\[/);
  assert.match(output, /Lane 1 of 3/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/doctor.test.mjs tests/support-bundle.test.mjs tests/plain-status.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement truthful checks and consented export**

Doctor checks Node/Claude/Codex versions, Codex auth readiness, broker startup, state permissions,
external-editor ownership, terminal capabilities, and optional web/browser/image surfaces. It does
not perform account mutation. Support export first renders a manifest and redaction counts, then
requires confirmation. Plain status is the screen-reader and non-TTY fallback.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/doctor.test.mjs tests/support-bundle.test.mjs tests/plain-status.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/lib/doctor.mjs plugins/fleet/scripts/lib/support-bundle.mjs plugins/fleet/scripts/lib/plain-status.mjs tests/doctor.test.mjs tests/support-bundle.test.mjs tests/plain-status.test.mjs
git commit -m "feat: add private diagnostics and accessible status"
```

### Task 15: End-to-end fake app-server and PTY verification

**Files:**
- Create: `tests/e2e-fleet.test.mjs`
- Create: `tests/pty-console.test.mjs`
- Create: `tests/fixtures/fake-claude-editor-host.mjs`
- Create: `scripts/run-pty-smoke.mjs`

**Interfaces:**
- Exercises: contract -> scheduler -> broker -> two lanes -> state -> console -> follow-up ->
  verifier -> return.
- PTY harness records only terminal events and sanitized fixture data.

- [ ] **Step 1: Write the failing E2E scenario**

```js
test("fleet completes, verifies, renders, and returns without changing the draft", async (t) => {
  const e2e = await startFleetFixture(t);
  await e2e.start([investigatorContract(), verifierContract()]);
  await e2e.waitFor("verified");
  const session = await e2e.openConsole(["down", "enter", "q"]);
  assert.equal(session.returnedToHost, true);
  assert.equal(session.draftAfter, session.draftBefore);
  assert.equal(e2e.appServerStarts, 1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/e2e-fleet.test.mjs tests/pty-console.test.mjs`

Expected: FAIL until all real components are connected.

- [ ] **Step 3: Add only the integration glue required by the scenario**

Use the fake Codex server for deterministic app-server events and a real PTY library only as a
development dependency if Node's test harness cannot supply a ConPTY/PTY. If a native package is
needed, isolate it to tests and verify prebuilt support for every CI architecture.

- [ ] **Step 4: Run E2E and leak checks**

Run: `node --test tests/e2e-fleet.test.mjs tests/pty-console.test.mjs`

Expected: PASS.

Run: `node scripts/run-pty-smoke.mjs --assert-clean-terminal --assert-draft-unchanged`

Expected: PASS and no owned child process remaining.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-fleet.test.mjs tests/pty-console.test.mjs tests/fixtures/fake-claude-editor-host.mjs scripts/run-pty-smoke.mjs package.json package-lock.json
git commit -m "test: verify fleet and terminal handoff end to end"
```

### Task 16: Security, performance, and cross-platform CI gates

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/check-secrets.mjs`
- Create: `scripts/check-licenses.mjs`
- Create: `scripts/check-performance.mjs`
- Create: `plugins/fleet/scripts/lib/process-ownership.mjs`
- Create: `tests/process-ownership.test.mjs`
- Create: `tests/property-input.test.mjs`

**Interfaces:**
- Produces one `npm run verify` gate and platform evidence artifacts.
- `process-ownership.mjs` produces `cancelOwnedProcess(record)` and verifies PID plus recorded
  process-start identity before termination.
- Performance output is JSON with startup, idle CPU sampling, redraw rate, retained heap, state
  size, and orphan count.

- [ ] **Step 1: Add failing process/property/performance assertions**

```js
test("cancel refuses a reused PID whose ownership token differs", async () => {
  const result = await cancelOwnedProcess({ pid: 4242, recordedStart: 10, observedStart: 20 });
  assert.deepEqual(result, { cancelled: false, reason: "ownership-mismatch" });
});

test("renderer survives hostile dimensions and Unicode", () => {
  for (const fixture of generatedTerminalFixtures(1000))
    assert.doesNotThrow(() => renderScreen(fixture.view, fixture.terminal, fixture.preferences));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/process-ownership.test.mjs tests/property-input.test.mjs`

Expected: FAIL until ownership and hostile-input handling are complete.

- [ ] **Step 3: Implement verification scripts and CI matrix**

Test Node 18.18-compatible and current LTS behavior on `windows-latest`, `macos-13`,
`macos-14`, and `ubuntu-latest`. Run unit/integration tests everywhere and PTY smokes where the
runner exposes an interactive terminal. Require plugin validation, type checking, secret scan,
license audit, CodeQL, dependency review, and build artifact checksums. Set budgets: startup p95
under 250 ms, idle dashboard CPU average under 1%, redraw <= 4 Hz, retained heap under 64 MiB with
256 lanes, and zero owned orphan processes.

- [ ] **Step 4: Run the full local gate**

Run: `npm run verify`

Expected: PASS on Windows; CI remains required before macOS/Linux claims.

- [ ] **Step 5: Commit**

```bash
git add .github scripts/check-secrets.mjs scripts/check-licenses.mjs scripts/check-performance.mjs plugins/fleet/scripts/lib/process-ownership.mjs tests/process-ownership.test.mjs tests/property-input.test.mjs package.json package-lock.json
git commit -m "ci: enforce security and platform gates"
```

### Task 17: Human README and open-source project surface

**Files:**
- Create: `README.md`
- Create: `ARCHITECTURE.md`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `docs/THREAT_MODEL.md`
- Create: `docs/TROUBLESHOOTING.md`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/pull_request_template.md`
- Create: `tests/docs.test.mjs`
- Create: `scripts/check-doc-links.mjs`

**Interfaces:**
- README leads with what the tool does, a truthful 30-second install, how the handoff works, the
  permission model, resource behavior, current support matrix, and upstream attribution.
- Visuals are added only from the verified running console and contain sanitized fixture data.

- [ ] **Step 1: Write failing documentation assertions**

```js
test("README is concrete, independent, and contains no unverified claims", async () => {
  const readme = await read("README.md");
  assert.match(readme, /not affiliated with or endorsed by OpenAI or Anthropic/i);
  assert.match(readme, /Ctrl\+G/);
  assert.match(readme, /Apache-2\.0/);
  assert.doesNotMatch(readme, /revolutionary|game-changing|10x|magic|seamless/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/docs.test.mjs`

Expected: FAIL because the public documentation is missing.

- [ ] **Step 3: Write the documentation in a direct maintainer voice**

Explain why the project exists: Claude Code is the orchestrator, Codex supplies independent
workers, and existing tools lacked a compact operator view and explicit authority/evidence model.
Describe real constraints and failure modes. Include copy-paste installation, setup, use, update,
rollback, and uninstall commands. Do not include generated testimonials, invented benchmarks,
fake adoption numbers, or an empty screenshot section.

- [ ] **Step 4: Capture and add verified visuals**

After the real console passes E2E, render wide and compact fixture sessions to ANSI, capture PNG
images using a deterministic terminal profile, inspect them visually, redact identifiers, and add
them under `docs/assets/`. Add the images to README only after comparing their displayed fields
with the fixture state.

- [ ] **Step 5: Verify docs and links**

Run: `node --test tests/docs.test.mjs`

Expected: PASS.

Run: `node scripts/check-doc-links.mjs`

Expected: PASS with no broken local links and no unpinned installation command.

- [ ] **Step 6: Commit**

```bash
git add README.md ARCHITECTURE.md SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md docs .github/ISSUE_TEMPLATE .github/pull_request_template.md tests/docs.test.mjs scripts/check-doc-links.mjs
git commit -m "docs: publish the Codex Fleet project guide"
```

### Task 18: Release packaging, installation, and live Claude smoke

**Files:**
- Create: `scripts/package-plugin.mjs`
- Create: `scripts/release-check.mjs`
- Create: `.github/workflows/release.yml`
- Create: `tests/package.test.mjs`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/fleet/.claude-plugin/plugin.json`

**Interfaces:**
- Produces: reproducible `fleet-0.1.0.zip`, SHA-256 checksum, provenance statement, marketplace
  install, and rollback instructions.
- `scripts/package-plugin.mjs` exports `buildPluginArchive(options)` for package tests and invokes
  the same function from its CLI entry point.

- [ ] **Step 1: Write failing package integrity tests**

```js
test("release archive contains only the installable plugin and required notices", async () => {
  const archive = await buildPluginArchive({ sourceDateEpoch: 1786914000 });
  assert.deepEqual(archive.unexpectedFiles, []);
  assert.equal(archive.has("LICENSE"), true);
  assert.equal(archive.has("NOTICE"), true);
  assert.equal(archive.has(".claude-plugin/plugin.json"), true);
  assert.equal(archive.containsSecretPattern, false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/package.test.mjs`

Expected: FAIL because packaging is missing.

- [ ] **Step 3: Implement deterministic packaging and release checks**

Normalize archive order, timestamps, and modes; exclude tests, Git data, local state, and support
bundles. Verify manifest version parity, clean Git status, tag/version match, full test gate,
license/notice presence, secret scan, and checksum before release.

- [ ] **Step 4: Run local development install and real Claude handoff**

Run: `claude --plugin-dir ./plugins/fleet`

Inside Claude: run `/fleet:doctor`, `/fleet:setup`, restart if requested, launch a two-lane fixture,
press `Ctrl+G`, navigate with arrows and mouse, open the preserved editor, return to Fleet Console,
exit with `q`, and confirm the same Claude draft/session. Then run `/fleet:uninstall` and verify the
prior editor configuration returns unchanged.

- [ ] **Step 5: Run the release gate**

Run: `npm run verify && node scripts/release-check.mjs --version 0.1.0`

Expected: PASS and emit archive plus checksum under `dist/`.

- [ ] **Step 6: Commit and tag only after CI is green**

```bash
git add scripts/package-plugin.mjs scripts/release-check.mjs .github/workflows/release.yml tests/package.test.mjs .claude-plugin/marketplace.json plugins/fleet/.claude-plugin/plugin.json package.json package-lock.json
git commit -m "feat: package the first Fleet release"
git tag -s v0.1.0 -m "Codex Fleet v0.1.0"
```

## Final verification sequence

1. `npm ci --ignore-scripts`
2. `npm run typecheck`
3. `npm test`
4. `claude plugin validate ./plugins/fleet --strict`
5. `node scripts/check-secrets.mjs`
6. `node scripts/check-licenses.mjs`
7. `node scripts/check-performance.mjs`
8. `node scripts/run-pty-smoke.mjs --assert-clean-terminal --assert-draft-unchanged`
9. `npm run verify`
10. Confirm Windows CI, macOS Intel/Apple Silicon CI, and Linux x64/arm64-equivalent gates.
11. Perform clean marketplace install, upgrade, rollback, and uninstall in disposable profiles.
12. Perform fresh independent source, package, and documentation verification.

The project is complete only when the acceptance checklist in the design specification has direct
evidence and the public README reports the same support level as the release artifacts.
