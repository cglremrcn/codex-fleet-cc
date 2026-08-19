---
name: follow-up
description: Continue one completed or needs-controller Fleet lane in the same Codex thread without widening its original authority.
argument-hint: <lane-id> <bounded-message>
---

# Fleet lane follow-up

Require an existing `complete` or `needs-controller` lane ID and a bounded message. Read the lane result,
structured controller request, and original authority first. Continue only when the message stays inside
the already-granted authority, objective, workspace, and exclusions. Fleet already performs up to two
automatic same-thread continuations for plan-only, incomplete, malformed, or redundant-approval results;
use this skill for a controller-supplied clarification or resolution, not to duplicate that recovery.
New scope, authority, external effects, or an unresolved user choice must stop for a new preview and
explicit confirmation.

Pass one schema-1 JSON contract as UTF-8 standard input—without shell interpolation—to:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" follow-up --stdin --json
```

Then call `result --wait` for the same lane. Confirm that the Codex thread ID is unchanged and the turn
ID changed. Report the structured outcome and evidence; do not upgrade `complete` to `verified`.
