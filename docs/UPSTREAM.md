# Upstream provenance

Codex Fleet for Claude Code uses selected parts of
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) as its Codex app-server
foundation.

- Upstream commit: `db52e28f4d9ded852ab3942cea316258ae4ef346`
- Upstream tag at import: `v1.0.6`
- Upstream license: Apache-2.0
- Imported on: 2026-08-17

The upstream files are isolated under `plugins/fleet/scripts/lib/upstream`. This keeps the
OpenAI-derived transport and job-control foundation separate from Fleet's orchestration, policy,
state, and terminal UI. Every imported runtime file listed below was byte-for-byte identical to
the named upstream commit at import time. Its SHA-256 is recorded so later changes remain visible.

| Imported file | SHA-256 at import |
|---|---|
| `app-server-protocol.d.ts` | `c4d141174754e04ef1cd1b904cd800d05e3174a772f86f0fc9c3f4d30ec3daf5` |
| `app-server.mjs` | `5dad5ca067fb2f54ef27f9c64b9c7e2bc2c60c475a08fd6e97ed45963d098c7d` |
| `args.mjs` | `5aa5382f6fd6d5ca4045d3207d2a8fec122cf9877c0d593204fadf05af3f3575` |
| `broker-endpoint.mjs` | `381aec89862e5c64b3afc3950fb5d92af99680b112b4b56cf2a3ac81549e8769` |
| `broker-lifecycle.mjs` | `edda09d1c62b78293c8509b6c384ecf61c1ec8b0d382f22327e46f0c3eddf30f` |
| `claude-session-transfer.mjs` | `dba7cb4638efca03180ea9eaa7084a7bdb416bb2e0fc33629f8308faab781b9a` |
| `codex.mjs` | `3446bab264ca51ee16f8a1458248973b1e19b53a5766b33ebad4c0eae813cb2b` |
| `fs.mjs` | `87ed75d895d7554ad4eb25e245774a428fca260c4a7ed8d58fdc9d02451aed43` |
| `git.mjs` | `a188e12fb9c843843e075822ebe1e41aab5d7526345d69316bede455e03a6384` |
| `job-control.mjs` | `35db61aaa4556dad92fb8e0309ef414f022c99cf66d7c27d279db4964fd6736b` |
| `process.mjs` | `6f36e4959109412f49e2c0768e5685c1ed68c01f5b69073855f1de6d8ece55d9` |
| `prompts.mjs` | `1ae9ae451be12b80750af7cfc8bb273a21081d4db10b71c61a1e0596586c6637` |
| `render.mjs` | `d4b892b3d25f0e22e7fb561a77bac308c5663b79a3183ad63307aee3aa2c8b39` |
| `state.mjs` | `f133ceef8eb187dd993208e17160459fef6632320ad19c9e230c180049ec598a` |
| `tracked-jobs.mjs` | `eb61689344857155762d6a7246cb2ceed683b6ca67d41d761e9b16c2a2fa5c9d` |
| `workspace.mjs` | `3a778422ddca7002174a1df0c6e0f2705264c2ffc81acf18d85bedf6cd513d29` |

The matching upstream test sources were preserved under `tests/upstream`:

- `broker-endpoint.test.mjs`
- `bump-version.test.mjs`
- `commands.test.mjs`
- `fake-codex-fixture.mjs`
- `git.test.mjs`
- `helpers.mjs`
- `process.test.mjs`
- `render.test.mjs`
- `runtime.test.mjs`
- `state.test.mjs`

Those files remain byte-for-byte reference copies. The full upstream `runtime.test.mjs` exercises
the official plugin's command, hook, and directory layout, so running it unchanged inside Fleet
would test paths and entry points Fleet deliberately does not ship. Runtime Task 5 therefore
ported its broker endpoint contract into `tests/upstream-runtime-compat.test.mjs` and added Fleet's
adapter integration suite in `tests/runtime-adapter.test.mjs`. The port revealed that the upstream
helper uses the host path separator even when asked to create an endpoint for another platform.
Fleet's derived `plugins/fleet/scripts/lib/broker-endpoint.mjs` uses the target platform instead.
The ported files are marked as modified at their source; the originals remain available for
future upstream diffs.

## Update procedure

1. Fetch the intended upstream tag or commit from the official OpenAI repository.
2. Review its license and NOTICE before copying any file.
3. Diff every imported file against the currently recorded source.
4. Run the inherited compatibility tests and Fleet's adapter tests.
5. Update the commit, tag, hashes, exact/derived status, and NOTICE in one reviewed commit.

The Apache-2.0 license permits use, modification, and redistribution subject to its conditions.
It does not grant trademark rights or imply an endorsement by OpenAI.
