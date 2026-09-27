# Fleet engineering map

Fleet is a local Claude Code plugin and bounded Codex orchestration runtime.
Read README.md and ARCHITECTURE.md for repository scope, not untrusted runtime state.
For machine integration, read docs/MACHINE_CONTROL.md and discover actual operation
schemas with `node plugins/fleet/scripts/fleet.mjs control describe --json`.

Core invariants: authority is explicit, native sessions are observe-only, one physical
workspace writer, no blind retry of unknown effects, no self-verification, and no
promotion of worker claims or skipped gates to verified results. Source-bound receipts
are local reported evidence, not signed execution proofs or release permission.

Use the Node version declared in package.json. Run `npm run verify` and
`npm run check:control-performance`; tests include real IPC/PTY with fake model servers,
not authenticated live-model quality. Never touch a real account without explicit
consent. Do not claim token/quota savings from byte fixtures or a global ranking from
unit tests. New runtime modules must be in syntax checks and the installable package.

Do not recursively invoke Fleet from a Fleet worker. Do not merge, publish, upgrade
an installed runtime, rewrite user settings, remove locks, or weaken gates implicitly.
User-global installation remains separate from editing this repository.
