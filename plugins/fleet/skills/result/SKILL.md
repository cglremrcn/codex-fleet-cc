---
name: result
description: Read one Fleet lane's stored result and evidence without launching new work.
argument-hint: <lane-id>
---

# Fleet lane result

Require a lane ID, then run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" result --workspace "${CLAUDE_PROJECT_DIR}" --lane "$ARGUMENTS" --json
```

Return the stored result, evidence, authority, token usage, and terminal state. Preserve the distinction
between model output, independently verified evidence, and orchestration metadata. If no result exists,
report the deterministic CLI error. Never retry or launch a replacement lane implicitly.
