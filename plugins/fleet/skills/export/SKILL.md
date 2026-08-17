---
name: export
description: Export a redacted Fleet evidence bundle only after previewing its exact destination and contents.
argument-hint: <output-path>
disable-model-invocation: true
---

# Export Fleet evidence

Require an output path. Generate and show an exact preview of the destination, lane scope, redaction
policy, and file that would be created:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" export --workspace "${CLAUDE_PROJECT_DIR}" --output "$ARGUMENTS" --json
```

This first call must report `writesPerformed: false`. Ask for explicit confirmation and retain the
returned `confirmationToken`. Only after approval, repeat the command with
`--confirm-token "<exact-token>"`. The token is bound to the previewed bundle and destination; never
substitute a generic yes/no flag.

Never export raw secrets, hidden prompts, credentials, or unredacted process output. If export support
is unavailable, report that exactly and create nothing by another route.
