---
name: export
description: Export a redacted Fleet evidence bundle only after previewing its exact destination and contents.
argument-hint: <output-path>
disable-model-invocation: true
---

# Export Fleet evidence

Require an output path. Generate and show an exact preview of the destination, lane scope, redaction
policy, and files that would be created. Ask for explicit confirmation; treat that approval as the
preview token for this one export only. Then run the deterministic Fleet export through
`node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" export --workspace "${CLAUDE_PROJECT_DIR}" --output "$ARGUMENTS" --json`.
Never export raw secrets, hidden prompts, credentials, or unredacted process output. If export support
is unavailable, report that exactly and create nothing by another route.
