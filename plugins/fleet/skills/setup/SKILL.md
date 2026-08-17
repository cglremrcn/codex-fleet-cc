---
name: setup
description: Preview the reversible Claude Code external-editor integration for Fleet. Use only when the user explicitly asks to install or configure Fleet.
disable-model-invocation: true
---

# Fleet setup

Run the deterministic setup preview for `${CLAUDE_PROJECT_DIR}` through:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" setup --workspace "${CLAUDE_PROJECT_DIR}" --json
```

Show the exact preview, including every settings path and value Fleet proposes to own. Never edit
Claude settings, keybindings, shell profiles, or project files by hand. Apply only after the user gives
explicit confirmation using the exact preview token. If setup support is unavailable, report that
verbatim; do not emulate the write. Fleet data belongs under `${CLAUDE_PLUGIN_DATA}` and uninstall
may remove only files recorded in its ownership manifest.
