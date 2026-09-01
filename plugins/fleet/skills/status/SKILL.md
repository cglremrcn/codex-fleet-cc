---
name: status
description: Read the current workspace's Fleet lane states and unresolved outcomes without launching or changing work.
---

# Fleet status

Run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" status --workspace "${CLAUDE_PROJECT_DIR}" --json
```

Summarize each lane's ID, role, model, effort, authority, status, evidence, and token usage exactly as
returned. Distinguish `verified`, `failed`, `blocked`, `interrupted`, and `outcome_unknown`. Do not turn unknown into
failed or successful. This command must not launch a lane, create state, or call a model.
