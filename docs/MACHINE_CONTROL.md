# Fleet machine-control API v1

The integrated source exposes a dependency-free JSON CLI and Node client for Claude
Code, Codex, or any trusted local harness. This is an additive control surface over
the existing supervisor, not a second scheduler, an MCP server, a remote service,
or native-thread adoption. Source changes do not update a copied installed runtime.

## Discover, do not memorize

```sh
node plugins/fleet/scripts/fleet.mjs control describe --json
node plugins/fleet/scripts/fleet.mjs control describe prepare --json
node plugins/fleet/scripts/fleet.mjs control describe start --json
```

Discovery is offline and starts neither a supervisor nor a model. The small index
lists effect/retry categories; request one operation for its structural input schema
and semantic constraints. `start` and `prepare` expose the actual nested contract
fields instead of an opaque object. Existing authority/catalogue/path validation still
runs before admission; JSON Schema alone cannot prove permission or model availability.

Send one UTF-8 JSON envelope to exact argv `control --stdin --json`:

```json
{
  "schemaVersion": 1,
  "requestId": "observation-1",
  "workspacePath": "/absolute/canonical/worktree",
  "operation": "observe",
  "params": { "maxBytes": 8192 }
}
```

Paths must refer to an existing directory. Use a real canonical worktree root for
source evidence. On Windows use a JSON-escaped absolute Windows path; do not copy the
POSIX placeholder literally. Prompts go in stdin, never into a shell command string.

Every response echoes version, requestId, operation, `ok`, and either `data` or a safe
`error`. The CLI's nonzero exit code also reports errors; hosts must inspect `ok`.
Errors distinguish safe observation retries from same-plan replay and reconciliation
requirements. A timeout is not proof that a task did not start. **requestId is only
correlation, not model-turn idempotency.** There is no automatic mutation retry.

## Operations and effects

| Operation | Behavior | Starts inference? |
| --- | --- | --- |
| `describe` | Small index or one exact schema | No |
| `observe` | Paged, coalesced state deltas | No; may start local supervisor |
| `wait` | Shared cursor-based local snapshot wait | No |
| `result` | Full sanitized result, identity, or a selected paged section | No |
| `models` | Exact runtime model/effort discovery | No; may initialize app-server |
| `start` | Existing admission contract with unchanged safety gates | Yes |
| `continue` | Existing thread with pinned turn/revision | Yes |
| `cancel.preview` | Exact current cancellation identity | No |
| `cancel.apply` | Apply the exact preview after operator decision | No new turn; interrupts owned work |
| `checkpoint` | Bind completed worker and source to required checks | No |
| `attest` | Bind fresh verifier's reports to actual evidence-file hashes | No |
| `check` | Revalidate source-bound receipt against current state | No |
| `prepare` | Select a bounded eligible DAG wave, store short-lived plan | No |
| `apply` | Recheck and admit that wave once per live plan token | Yes |

## Programmatic orchestration without context flooding

This example only observes; it does not launch a model turn or grant authority:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { createFleetControlClient } from "../plugins/fleet/scripts/lib/control-client.mjs";

const workspacePath = await fs.realpath(process.cwd());
const client = createFleetControlClient({
  workspacePath,
  scriptPath: path.resolve("plugins/fleet/scripts/fleet.mjs")
});
let state = await client.observe(undefined, { maxBytes: 8192 });
console.log(JSON.stringify({ totals: state.totals, attention: state.lanes.filter(x => x.attention) }));
if (state.totals.active || state.totals.queued) {
  const event = await client.wait(state.cursor, { timeoutMs: 600000 });
  state = await client.observe(state);
  console.log(JSON.stringify({ event, totals: state.totals }));
}
```

Use a trusted absolute entrypoint rather than a model-selected executable. This import
example is for a module under the repository's `scripts/` directory; the packaged
client is `scripts/lib/control-client.mjs` relative to the plugin root. The transport
uses exact argv, bounded stdout, drained but unexposed stderr, and a four-client default
concurrency cap. A timed-out CLI child can be terminated without pretending its detached
supervisor or model task was cancelled.

Observations do not contain prompts, reasoning or full work/result bodies. Timestamps
alone do not change a cursor. Usage is opt-in via `includeUsage:true` and must remain
consistent for a cursor/wait; it is provider-reported telemetry, never billing or quota.
Archived records are hidden, but `archivedAttention`, bounded `archivedAttentionIds`
and a truncation flag keep hidden unresolved work visible. Inspect/reconcile those IDs.

At low level, follow `nextPage` exactly and retain the old cursor until the final page.
The client validates and atomically assembles the frozen batch. Restart or eviction
means a reset, not imaginary event continuity. This is a **coalesced state view, not a
persistent event journal**. Intermediate states may collapse into the latest state.
One bounded in-flight snapshot read is shared by waiters, even after UI deadlines;
local sampling is at most four times per second. It is not a network/model polling
loop and not an assertion of an event-subscription implementation.

For result inspection, ask for `section:"identity"` first. The sections `work`, `checks`,
`artifacts`, `evidence` and `events` return revision-bound fragments and a complete `next`
request. Long strings split on Unicode code points. `client.readSection(id,"checks")`
assembles them in code; only send relevant conclusions to the orchestrating model.
Never mix pages after `CONTROL_RESULT_CHANGED`. `section:"full"` preserves the original
sanitized result shape but may exceed the response cap; use sections in that case.

## Source-bound reported verification

After completed implementation/integration, call:

```json
{"operation":"checkpoint","params":{"laneId":"implement","requiredChecks":["unit"]}}
```

This abbreviated example shows operation/params only; use the full envelope above.
Retain checkpointId, source digest, and verifierBinding. Create a fresh
`independent-verifier`, adding **both** returned verificationCheckpoint and
verificationPlan fields to its admission. It must be non-interactive, network-off,
read-only and free of mutable capabilities. Use exact discovered model/effort values.
It cannot be steered or continued after binding: changing its instructions requires
a fresh bound verifier. The scheduler reserves its identity before asynchronous source
checking and excludes writers until it finishes. Changed source refuses dispatch
before the verifier's model turn.

The verifier's structured verificationResults must have exactly one `passed` report
for each required check, with `evidence` equal to the actual inspected workspace-relative
file. Missing, skipped, conflicting or failed required checks do not pass. After it
completes, call `attest` with checkpointId, verifierLaneId and one `{check,path}` per
required check. The files must exist, be regular non-linked files, and match its report.
Then call `check` with receiptId; it returns `current`, `reason`, `checkedAt`, and always
`releaseAuthorized:false`. A result exposes recent receipt metadata for rediscovery;
metadata alone is unchecked. Old `verified` status alone never proves current readiness.

The checkpoint includes immutable contract and instruction-chain digests, admission,
turn/revision, and bounded result identity. Source binds HEAD/index, actual tracked
working bytes (including deletions) and nonignored untracked files. The receipt binds
the verifier and evidence hashes too. Editing source, steering/continuing a worker,
changing evidence or replacing the verifier invalidates the old claim. Valid records
survive restart in a private bounded atomic ledger. Legacy lanes without provenance
cannot be retrospectively upgraded by inventing a digest.

**Trust boundary:** a receipt binds what was reported to particular content. It does
not independently execute or sign tests, prove a test is adequate, authenticate a
hostile same-user agent, or authorize a release. Ignored dependencies and external
browser/database/provider state are not source-bound. Named evidence files are hashed
separately. The controller may supply real authorized host-produced logs for the
read-only verifier; describe that honestly rather than claiming a re-run.

Source capture refuses non-Git roots, subdirectories, symlinks, hardlinks, submodules,
unmerged index entries, unsafe paths and over-budget trees. It has before/after
inventory and metadata checks, not an atomic filesystem snapshot. Fleet admission
barriers coordinate **this supervisor-rooted workspace**; an unrelated process or
another harness is not fenced by an OS-wide resource lease. Use physical isolated
worktrees for independent writers. Logical labels are not isolation.

## Evidence-Bounded Frontier v1

A preparation contains the unmodified candidate start contract, one graph node per
candidate, and estimated budget with a verification reserve. Nodes have positive
estimatedTokens and estimatedMs. Optional dependencies are `{laneId,receiptId}`;
internal candidate edges require no receipt until a subsequent wave.

The heuristic computes downstream critical-path duration, prioritizes bounded waiting
age tiers, then critical path, estimated tokens and stable input order. FIFO is an
explicit comparison strategy. Candidates with unmet dependencies stay deferred.
Existing prerequisites need a current receipt for their exact lane. Active, queued and
reserved work consumes capacity. Budget is estimates minus reserve; one mutable
candidate runs alone in a prepared wave. Roles/labels cannot bypass that decision.

`prepare` returns selected/deferred reasons and a two-minute RAM-only planToken, or
null when nothing is eligible. It does not initialize Codex or validate live model
availability. `apply` revalidates source, execution identity, dependency receipts and
capacity **again after model discovery**, then admits only the selected wave through
the existing scheduler. Concurrent calls with the same live token join one promise;
replay returns its original admission result. The response is historical admission,
not a fresh status. If admission may have partly occurred, that token will not repeat
it. After restart or expiration, observe every candidate ID before preparing again.

Whole-tree receipt matching is conservative: an unrelated edit can invalidate earlier
dependency evidence. Integrate and verify sensible waves rather than pretending
per-file independence is proven. This heuristic is not a new optimality theorem,
a global cross-worktree scheduler, or a hard provider token/price cap. A wrong duration
estimate can make its ordering worse than FIFO; compare on your actual task corpus.

## Bounds, compatibility and rollout

Requests: 128 KiB UTF-8, depth 16, 16,384 JSON nodes. Replies: 240 KiB. Observation
pages: 2–64 KiB, default 8 KiB; 256 retained lanes; 16 snapshots and eight batches
within 2 MiB. Waiters: 16 shared waits. Plans: eight/512 KiB, two-minute lifetime.
Evidence: 64 checkpoints + 64 receipts within 512 KiB. Source: 4,096 files, 16 MiB per
file, 64 MiB total, 15-second overall budget. Bounds fail visibly; they do not drop
unproven work or widen authority. Client result assembly is capped at 2 MiB.

Claude's packaged `control` skill and the repository `.agents/skills/fleet-control`
skill route to this same implementation. Codex repository discovery is not global
installation. Other local hosts use JSON stdin or the Node client; adapters for MCP,
HTTP, A2A or remote authorization are not supplied by this change.

Run `npm run verify`. The new control-performance gate emits synthetic bytes and
latency; authenticated model quality and quota effects are separate evaluations.
Keep the stack's review order and use a disposable profile for a live canary. A source
checkout does not replace an already-copied Ctrl+G runtime, and no version bump,
release, production install or user-global setting change is implied.
