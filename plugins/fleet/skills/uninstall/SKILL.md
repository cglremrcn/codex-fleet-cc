---
name: uninstall
description: Preview and remove only Fleet-owned Claude integration files after explicit user confirmation.
disable-model-invocation: true
---

# Uninstall Fleet integration

Read the ownership manifest under `${CLAUDE_PLUGIN_DATA}` and show an exact preview of settings values
to restore, owned files to remove, modified files that will be retained, and restart requirements. Ask
for explicit confirmation; the accepted preview token authorizes only that immutable plan. Then run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" uninstall --workspace "${CLAUDE_PROJECT_DIR}" --json
```

After explicit confirmation, rerun the command with `--confirm-token "<exact-token>"`.

Never delete workspace state, user-edited files, an unowned editor setting, or anything absent from the
ownership manifest. On drift, stop and preserve the file.
