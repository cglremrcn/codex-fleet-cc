---
name: cancel
description: Cancel one owned Fleet lane after a visible preview and explicit user confirmation.
argument-hint: <lane-id>
disable-model-invocation: true
---

# Cancel a Fleet lane

Require a lane ID. Read status first and show an exact preview containing the lane ID, current state,
owned process if any, and what cancellation can and cannot guarantee. Ask for explicit user confirmation.
Only after that confirmation run the high-level identity-bound shortcut:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" cancel "$ARGUMENTS" --workspace "${CLAUDE_PROJECT_DIR}" --json
```

The CLI performs its protocol preview and confirmation internally. The confirmation digest is bound to
the current lane/thread/turn; if that identity moves between protocol steps, cancellation is refused.
Always inspect and report the returned `touchedFiles` before proposing any revert or cleanup. Never stop
an unowned process, broaden the target, delete touched files automatically, or report success unless
Fleet returns `accepted:true`.

For protocol debugging only, `fleet cancel --help` documents the low-level structured two-step API; do
not make users or Claude manually copy its confirmation token during normal operation.