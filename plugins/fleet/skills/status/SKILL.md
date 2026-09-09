---
name: status
description: Read the current workspace's Fleet lane states and unresolved outcomes without launching or changing work.
---

# Fleet status

Run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs" status --workspace "${CLAUDE_PROJECT_DIR}" --json
```

This is a zero-model-turn observation. It must not create a supervisor, lane, or workspace state. If an
existing supervisor is live, Fleet may read its current snapshot so a queued lane includes its
`queueBlocker`; otherwise status falls back to persisted state. Explain the blocker instead of treating
`queued` as proof that work has started or will start.

Normal status hides records with `archivedAt`. Use `--archived` to inspect only archived lanes or
`--include-archived` when both sets are intentionally needed. When the selected workspace ledger is empty
but registered sibling worktrees for the same Git repository have lanes, report the returned
`workspaceRouting.relatedWorktrees` hint rather than saying that Fleet globally has no work.

Summarize each lane's ID, role, model, effort, authority, status, evidence, token usage, queue blocker,
and touched-file count when returned. Distinguish `verified`, `failed`, `blocked`, `interrupted`, and
`outcome_unknown`; never turn unknown into failed or successful.

Report `pendingRequests`, `pendingQuestionCount` and `pendingApprovalCount` when present. Use the inbox
skill for targeted detail; pending questions are not automatically safe to answer.