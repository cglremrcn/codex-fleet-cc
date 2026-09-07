# Harness navigation and observability

This guide describes navigation and observability in the integrated source. The
[control center](CONTROL_CENTER.md) extends it with cross-project/native inventory and saved views;
the [shared inbox](SHARED_INTERVENTION.md) adds project-scoped interventions. Updating source alone
does not upgrade an installed terminal runtime. Use a disposable profile for a live canary.

## Organize a large fleet

The default remains the flat, current-workspace list. Press `G` to cycle through **flat, folder,
checkout, status, role, model**. In a grouped view, `Enter` on a heading or `Space` toggles it;
`[` collapses every group and `]` expands every group. `Space` on a lane toggles its immediate parent.
`Enter` on a real lane retains the existing Codex thread view. `H`, `?`, or `F1` opens help.

A heading is not an agent. Message, cancellation and other runtime actions cannot target a heading.
Groups show matched agent counts, active counts and attention counts. Folding does not remove the
underlying agents or alter their state. Selection is preserved by stable identity where possible.
Fold state lasts for the current console session unless saved in a named view from the command palette.

Set an optional lane field such as:

```json
{ "groupPath": "backend/authentication" }
```

This is **logical task organization**, not a filesystem path, a worktree, an authorization grant or a
lock key. It supports 1–8 nonempty relative segments and at most 160 characters. Dot/parent segments,
absolute paths, backslashes and control characters are rejected. Old records without this metadata
appear under `Ungrouped` in folder mode. `checkout` groups use existing labels; labels alone do not
prove that writers are physically isolated.

Grouping itself does not discover other workspaces or native threads; use the control center scopes
for registered-project and connected app-server inventory.
The existing retained-state limit remains 256 lanes per workspace. Showing 100 agents does not mean
running 100 model turns concurrently; the normal bounded scheduler remains in charge.

## Filter without spending model turns

Press `/` and type up to 256 characters. All terms must match. Commas mean alternatives within a
field; prefix a term with `-` to exclude it. Double quotes preserve spaces. Matching is literal, not a
regular expression. Supported fields are `id`, `status`, `role`, `model`, `effort`, `checkout`,
`folder`, `label`, and `phase`; the control center also supports `project`, `source` and `parent`. Status, role and effort match exactly; other fields are substrings.

```text
status:running,blocked folder:backend -role:planner
label:"account settings" -status:cancelled
model:gpt-5.6-sol effort:high
```

Search covers the active scope's observed records; the default scope is the current workspace. Folded groups keep the matched counts;
headers are not included in the agent total. Escape clears an in-progress filter, as before.

## Discover models rather than guessing names

From the repository root:

```text
node plugins/fleet/scripts/fleet.mjs models --workspace . --json
```

In a Claude plugin session use the same command via `${CLAUDE_PLUGIN_ROOT}/scripts/fleet.mjs`.
The command queries the connected Codex app-server's `model/list`, follows bounded pagination and
returns exact model identifiers and supported effort values. It can start/connect the local
supervisor and broker; it does **not** create a Codex thread or inference turn. Results are cached
for 60 seconds in the runtime and simultaneous queries share one request sequence.

To opt a new root start contract into this catalogue, set:

```json
{ "modelPolicy": "runtime" }
```

Keep the existing required contract fields. Choose each lane's `model` and `effort` from the returned
catalogue. The supervisor rechecks them before admitting any lane. Malformed discovery, an unknown
model or an unsupported effort is an error, not permission to substitute another model. Contracts
without `modelPolicy` keep the legacy compatibility snapshot. There is no guaranteed Astra alias:
use the exact identifier exposed by the installed, authenticated Codex runtime.

A contract cannot supply its own trusted model catalogue. Discovery changes model selection only;
it does not widen sandbox, network, image, process or external-effect authority.

## Compact controller observations

```text
node plugins/fleet/scripts/fleet.mjs status --workspace . --summary --json
node plugins/fleet/scripts/fleet.mjs result --workspace . --lane LANE_ID --json
```

Compact status omits long result bodies and evidence lists. It retains identity, status, phase,
folder, reported usage, controller-attention signals and evidence/artifact counts. A controller
question is capped at 512 characters with an explicit truncation marker. Fetch the full result before
acting on a truncated request. The complete status JSON remains the default for existing consumers.
The existing unknown-outcome exit code (5) is preserved, including hidden-record selection warnings.

The summary is an observation, not an authorization object. Mutations must still pass through the
existing live supervisor checks. Prefer a meaningful transition and a targeted result read over
repeatedly copying the entire fleet history into Claude's context.

## Interpret usage honestly

Usage comes from Codex `thread/tokenUsage/updated` cumulative totals. The runtime replaces cumulative
snapshots instead of summing notifications, ignores lower-total replays and preserves valid counters
through scheduler state and restart recovery. Late usage for a terminal lane can still be recorded.
Missing usage remains unknown; it is not an invented zero. Reported cached-input and reasoning-output
counters are retained when present. The UI displays input/output/total; richer cost visualization is
not part of this change.

These counters are **not** ChatGPT subscription credit usage, dollar cost, remaining quota or a
promise of saved tokens. A smaller status payload is less context to copy, but its real model-token
and task-quality effects require an authenticated workload evaluation.

## Reliability changes and remaining boundaries

Within one supervisor-rooted workspace, different checkout labels no longer split the writer lock.
Delayed retired-turn events cannot replace a known current turn. Identical reconciled snapshots no
longer cause repeated successful disk writes; a failed write remains visible to its caller and does
not permanently poison the later write queue. None of these changes retries an external mutation.

The [dated harness review](reviews/2026-09-06-harness-review.md) preserves the earlier review baseline.
Registered-project/native inventory, saved views and a shared intervention inbox are now integrated.
Revision-bound verification and full multi-worktree scheduling remain separate architectural work.
