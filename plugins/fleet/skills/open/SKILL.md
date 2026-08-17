---
name: open
description: Open the Fleet console through Claude Code's configured external-editor path after read-only safety checks.
---

# Open Fleet Console

First run the read-only doctor through
`node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" doctor --workspace "${CLAUDE_PROJECT_DIR}" --json`.
Only tell the user to use Claude Code's existing external-editor shortcut when doctor proves Fleet owns
the configured editor values and the shortcut is not conflicting. Do not bind a new global shortcut.
The console runs while Claude is suspended in the same terminal; quitting it must restore the same
Claude session and draft. If ownership or shortcut safety is unknown, stop with that exact reason.
