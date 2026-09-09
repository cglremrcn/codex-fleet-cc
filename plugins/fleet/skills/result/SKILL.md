---
name: result
description: Read or wait for one Fleet lane's result and evidence without launching replacement work.
argument-hint: <lane-id>
---

# Fleet lane result

Require a lane ID. For the current stored snapshot run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" result --workspace "${CLAUDE_PROJECT_DIR}" --lane "$ARGUMENTS" --json
```

When the caller needs completion, prefer the event-backed waiter instead of shell polling:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" result --workspace "${CLAUDE_PROJECT_DIR}" --lane "$ARGUMENTS" --wait --summary
```

`--wait` has a ten-minute default timeout. A timeout is an observation that the lane is still
non-terminal, not a lane failure; report the returned live status and queue blocker if present. Use
`fleet watch --workspace "${CLAUDE_PROJECT_DIR}"` when the orchestration loop needs the next meaningful
Fleet event rather than one lane's terminal result.

Return the stored result, evidence, authority, fresh/cached token usage, touched files, and terminal state.
Preserve the distinction between model output, independently verified evidence, and orchestration
metadata. If no result exists, report the deterministic CLI error. Never retry or launch a replacement
lane implicitly, especially after `outcome_unknown`.