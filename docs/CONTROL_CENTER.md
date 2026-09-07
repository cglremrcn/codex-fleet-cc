# Fleet control center

These changes are source improvements on top of the navigation/observability PR, not an automatic
upgrade of an installed v0.2.1 plugin. Keep the working profile until a reviewed source release and
an isolated live canary have passed.

## One terminal, three explicit scopes

Press **W** to cycle current workspace, registered Fleet projects, and native Codex threads.
Press **:** for the searchable command palette. Scope switching clears the previous actionable
selection before loading the next index; a delayed response cannot replace the newer scope.

`G` now includes project, source, and parent-thread grouping, in addition to folder, checkout,
status, role and model. Parent grouping uses the upstream parent thread ID; it does not invent a
lineage from conversation text. Native children loaded only in memory are included through
`thread/loaded/list` and metadata-only `thread/read` calls, within explicit discovery budgets.

The project view reads only Fleet's local workspace records. The native view queries the connected
Codex app-server with explicit source types and all model providers. It does not scrape process
lists, read every conversation, resume sessions, or start inference. It includes available archived
threads only when requested from the CLI. A partial inventory or a failed project read is visible;
this is not a promise to discover accounts, remote machines, or app-server instances you did not connect.

An observed native thread is **read-only** in this UI. Enter opens a sanitized transcript, with no
composer, follow-up or cancel action. Finding a thread never transfers control ownership to Fleet.
A registered Fleet row routes controls through the private, revalidated canonical project registration,
using its original lane ID. Identical lane IDs in different projects remain distinct UI identities.

## Local registration and paged inspection

```bash
node plugins/fleet/scripts/fleet.mjs register --workspace . --name "My project" --json
node plugins/fleet/scripts/fleet.mjs projects --json
node plugins/fleet/scripts/fleet.mjs inventory --limit 100 --query 'project:My status:blocked' --json
node plugins/fleet/scripts/fleet.mjs inventory --workspace . --native --limit 100 --json
node plugins/fleet/scripts/fleet.mjs inventory --workspace . --native --archived --json
```

New workspaces register on admission. Older workspaces can be listed without being registered, but
cannot be controlled from another project's console until explicitly registered. Canonical paths
are stored privately on your machine, not in public inventory output. Do not share the local state
folder as a diagnostics archive.

Continue CLI pages with the exact returned `nextCursor`. Cursors are bound to the observed index
revision: a changed inventory requires a fresh first page, rather than silently skipping records.
Pages are bounded by both record count and serialized bytes. `truncated` and discovery warnings
remain separate from local pagination; a next cursor cannot make unavailable upstream data complete.

## Views, pins and attention

**A** sorts the most actionable records first. **F** pins the selected real lane. Pins affect local
ordering only, not execution priority. The palette provides original/recent/name ordering, refresh,
clear filters, save current view, load a named view, show/hide KITE and pause/resume its motion.

Views retain scope, grouping, filter, fold state, stable selection, pins and motion preference.
At most 16 named views are retained. Saving uses a bounded private atomic file and an exclusive
transaction with a revision check. Two consoles cannot silently overwrite each other's changes.
A stale lock is reported, not stolen. Back up the record and confirm the owning console has stopped
before investigating a leftover lock; do not delete locks from a running session.

Useful literal filters:

```text
project:backend status:running,blocked
source:subAgentThreadSpawn
parent:019a -status:observed
folder:images -role:planner
```

KITE can be hidden, reduced-motion preferences are respected, and clicking its top-right header
area focuses attention ordering. It is not an invented progress meter. The panel never equates a
model's completion claim, an observed idle thread, or a rendered mascot posture with independent
verification.

## Validation and scope

The tests cover cross-project identity, changed registrations, hostile records, bounded pages,
metadata-only discovery, ephemeral children, read-only native controls, saved-view conflicts,
real keyboard-to-palette dispatch, fixed viewport bounds and the existing terminal handoff.
No authenticated model turns or subscription savings benchmark were run by these tests.

Global worktree scheduling, native-thread adoption, durable archive migration and the shared
mid-turn request inbox are distinct capabilities, not implied by the new inventory.
