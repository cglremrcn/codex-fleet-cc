# Troubleshooting

Start with the deterministic doctor rather than changing settings by hand:

```bash
node plugins/fleet/scripts/fleet.mjs doctor --workspace . --json
```

The report distinguishes discovery, configuration, a successful smoke, denial and unknown state.

## `Ctrl+G` opens the old editor

Fleet setup has not been applied, Claude has not been restarted, or the settings file changed after
the setup preview. After plugin reload, the read-only SessionStart check offers to enable Fleet;
answer yes and let Claude apply the exact preview. Run `/fleet:setup` only if that offer does not
appear. Do not replace `VISUAL` or `EDITOR` manually. Fleet needs the ownership manifest to
uninstall safely.

The Fleet masthead shows the loaded integration version. If it is older than the installed plugin,
reload plugins and accept the SessionStart upgrade offer, or run `/fleet:setup` to preview the same
versioned upgrade. Fleet verifies the owned launcher/runtime, stages the target version, swaps it
atomically, and restores the prior owned files if the apply fails. Do not copy runtime files by hand.

If SessionStart reports unreadable or incomplete ownership, run `/fleet:doctor`. Do not rerun setup
or delete the manifest until the report identifies the conflict.

## The console says the original editor is unavailable

Fleet preserves the prior editor during setup. If no valid editor existed, `e` remains disabled.
Quit with `q`, configure an editor normally, then create and apply a fresh setup preview.

## The terminal looks broken after a crash

Fleet restores terminal modes on handled errors and signals. If the host terminal itself was
forcibly terminated, reset it using the terminal's normal reset command or open a new terminal.
Reproduce with:

```bash
npm run test:pty
```

Include terminal name, operating system and whether the alternate screen or mouse mode remained
active in a private support report.

## A lane is `OUTCOME_UNKNOWN`

Do not retry it. The prior request may already have sent, deployed, paid or deleted something.
Inspect the external system, record reconciliation evidence, then decide whether a new operation is
safe.

## Cancellation is denied

Fleet cancels only an owned Codex turn or a process whose PID and process-start identity still
match. A denial protects a process that may now belong to something else. Refresh status and let a
finished process reconcile naturally.

If doctor reports `ownership-mismatch`, Fleet did not terminate the process. The report includes the
recorded PID, a safe identity comparison, and the next step without guessing which application owns it.
Re-run doctor once; if the mismatch repeats, inspect or close that exact process through normal OS or app
controls. Do not kill processes broadly by executable name.

## Fleet keys appear to do nothing

Claude Code's `↓ to manage` hint controls Claude background agents. Press `Ctrl+G` to enter Fleet
Console, then use `↑`/`↓` or `j`/`k` to select lanes. With only one lane, Fleet reports that the selection
cannot change. `Tab` displays the focused panel in brackets. `Enter` or `m` opens the real selected Codex
thread; type directly and press `Enter` to send. `Ctrl+G` closes that session back to Fleet, then `q` or
`Esc` returns to Claude Code. Use `h` or `F1` when `?` is awkward on a Turkish keyboard. `p` pauses or
resumes KITE and shows an explicit notice; completed lanes visibly move while awaiting verification,
while verified, blocked, failed, interrupted, and unknown states remain locked.

## Desktop Browser or Computer Use is missing in a lane

`codex mcp list` proves configuration, not lane injection. A Codex desktop Browser/Chrome/Computer Use
skill name also does not prove a callable tool exists in the Fleet app-server thread. Run a lane-local,
non-mutating capability smoke. If the exact tool is absent, Fleet must stop or request an explicit parent
Claude fallback; it must not substitute Playwright, Chrome DevTools, generic web search, or a fresh browser
profile and claim the same signed-in session.

## Status shows no lanes

Status is workspace-scoped. Confirm the `--workspace` path and check the platform data directory.
Do not copy another workspace's state file. Run doctor to distinguish absent state from unreadable
or corrupt state.

## Codex or the broker is unavailable

Run `codex --version` and confirm the Codex CLI is authenticated in the same user session. Fleet
uses the existing local Codex configuration; it does not accept a replacement API key. A protocol
mismatch leaves read-only inspection available where safe but blocks new lane mutations.

## A support bundle is needed

Preview first:

```bash
node plugins/fleet/scripts/fleet.mjs export --workspace . --output fleet-support.json --json
```

Review the manifest and redaction counts. Write it only with the exact returned confirmation token.
Open the resulting file before sharing it. Never attach prompts, cookies or credentials separately.

## Verification commands

```bash
npm ci
npm run verify
node scripts/check-doc-links.mjs
```

Platform-specific failures should include the runner/OS, Node version, Claude version, Codex
version and the exact failing command. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the expected
report shape.
