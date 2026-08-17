---
name: cancel
description: Cancel one owned Fleet lane after a visible preview and explicit user confirmation.
argument-hint: <lane-id>
disable-model-invocation: true
---

# Cancel a Fleet lane

Require a lane ID. Read status first and show an exact preview containing the lane ID, current state,
owned process if any, and what cancellation can and cannot guarantee. Ask for explicit confirmation.
Only then pass the immutable cancellation contract on standard input to:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" cancel --stdin --confirm --json
```

The user's confirmation is the preview token for this one cancellation only. Never stop an unowned
process, broaden the target, or report success when Fleet returns `outcome_unknown`.
