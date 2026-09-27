---
name: follow-up
description: Continue one completed or needs-controller Fleet lane in the same Codex thread without widening its original authority.
argument-hint: <lane-id> <bounded-message>
---

# Fleet lane follow-up

Require an existing resumable lane ID and a bounded message. Read the lane result, structured controller request, and original authority first. Continue only when the message stays inside the already-granted authority, objective, workspace, and exclusions. New scope or authority means stop and return to the controller for a new preview and explicit confirmation; the same applies to a new external effect or unresolved user choice.

A mutable `outcome_unknown` is deliberately not directly resumable. Fleet first gets one automatic same-thread **report-only** repair opportunity under read-only, network-off authority when implementation appears complete but the structured report is malformed. If the result remains unknown, use the recovery flow (`reconcile`/evidence-backed `resolve`) before any follow-up or retry. Never layer a new mutable turn on top of uncertain prior effects.

Pass exactly this schema-1 shape as UTF-8 standard input—without shell interpolation:

```json
{"schemaVersion":1,"workspacePath":"ABSOLUTE_PATH","laneId":"LANE_ID","message":"BOUNDED_FOLLOW_UP"}
```

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" follow-up --stdin --json
```

The exact schema is also discoverable with `fleet follow-up --help`; source-code inspection is not part of normal operation. Then use event-backed `result --wait` for the same lane. Confirm that the Codex thread ID is unchanged and the turn ID changed. Report the structured outcome and evidence; do not upgrade `complete` to `verified`.