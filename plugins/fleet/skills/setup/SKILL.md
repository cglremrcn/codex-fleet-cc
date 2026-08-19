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

Keep the returned `confirmationToken` internal. Never ask the user to copy, paste, repeat, or store
it. Show the proposed settings paths and values, state that setup is reversible, and ask one plain
question: "Apply these changes now?" Do not treat the original setup request as confirmation of the
preview.

Only after the user explicitly confirms that displayed preview, rerun the same command with
`--confirm-token "<confirmationToken from that preview>"`. Pass the token yourself; do not expose it
as a user action. The CLI will reject the operation if settings changed after the preview. Never edit
Claude settings, keybindings, shell profiles, or project files by hand. Fleet data belongs under
`${CLAUDE_PLUGIN_DATA}` and uninstall may remove only files recorded in its ownership manifest.
