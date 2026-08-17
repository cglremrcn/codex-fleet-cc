---
name: doctor
description: Diagnose Fleet runtime availability, state paths, terminal compatibility, and Claude editor integration without changing anything.
---

# Fleet doctor

Run the read-only diagnostic:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" doctor --workspace "${CLAUDE_PROJECT_DIR}" --json
```

Report pass, fail, or unknown separately for Codex discovery, app-server compatibility, Fleet data
ownership, terminal capabilities, original editor availability, and shortcut safety. Never repair a
failure during doctor. Do not call Codex directly. If a check is not implemented or cannot be observed,
label it unknown rather than inferring success.
