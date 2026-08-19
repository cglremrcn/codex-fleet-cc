---
name: setup
description: Preview a fresh install or reversible version upgrade of the Claude Code external-editor integration for Fleet. Use when the user explicitly asks to configure or update Fleet, or explicitly accepts the SessionStart onboarding offer.
disable-model-invocation: false
---

# Fleet setup

Do not invoke this skill merely because SessionStart reports missing or outdated setup. First ask its
one plain confirmation question and wait. Continue only after the user explicitly accepts that
onboarding offer, or when the user directly asks to configure or update Fleet.

Run the deterministic setup preview for `${CLAUDE_PROJECT_DIR}` through:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" setup --workspace "${CLAUDE_PROJECT_DIR}" --json
```

Keep the returned `confirmationToken` internal. Never ask the user to copy, paste, repeat, or store
it. Show whether the preview is `fresh`, `current`, or `upgrade`, its current and target integration
versions, and the proposed settings paths and values. State that setup is reversible and ask one plain
question: "Apply these changes now?" Do not treat the original setup request as confirmation of the
preview.

Only after the user explicitly confirms that displayed preview, rerun the same command with
`--confirm-token "<confirmationToken from that preview>"`. Pass the token yourself; do not expose it
as a user action. The CLI will reject the operation if settings changed after the preview. An upgrade
also verifies the currently owned launcher/runtime before atomically swapping to the target runtime;
on failure it restores the prior owned files. Never edit Claude settings, keybindings, shell profiles,
or project files by hand. Fleet data belongs under `${CLAUDE_PLUGIN_DATA}` and uninstall may remove
only files recorded in its ownership manifest.
