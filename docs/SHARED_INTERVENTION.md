# Shared intervention inbox

Implemented as a connection-local state machine, an app-server request bridge, authenticated existing-
supervisor methods, Claude-facing read/proposal/delegated-answer commands, and an interactive terminal
view. This source package is stacked on the control-center and KITE review branches; it is not an
installed marketplace upgrade or a live-account certification.

## Human workflow

Press **I** from the dashboard, choose a request with arrow keys, and press Enter. The inbox uses the
selected Fleet lane's registered project (or the current project when none is selected). An observed
external Codex thread is not adopted: its owning client retains control. This inbox is project-scoped,
not a union of every background server on the computer. `1/2/3/4` select all open requests, questions,
approvals and history. `r` refreshes the list. Navigation never starts inference or a missing supervisor.

Read the details with arrows, PageUp/PageDown, Home/End. The exact thread, turn, item and request IDs,
revision, bounded request content and controller proposal are visible. For file-change approvals the
actual proposed changes must have been observed on the same item and turn; missing or redacted content
makes the request deny-only. A terminal smaller than 40 columns or 10 rows cannot authorize anything.

In details, Left/Right chooses an available action and Enter previews it. Mouse selection works in
the request list. Shortcuts remain available: `a` starts an answer wizard, `p` previews a proposed answer, `d` requests technical-question
delegation, `t` takes a delegated question back, `y` previews an operation acceptance, `x` previews a
rejection, and `u` rereads the request. Unavailable actions do nothing except explain the guard. In the
answer wizard use arrows for options or type an answer, then Enter to advance. Every question must be
answered. Arbitrary multi-select and secret input are deliberately not supported.

An action first produces a server-bound preview. Read the exact action, then press **uppercase Y** to
confirm once. Escape discards the preview locally; it never implies undoing an already transmitted
operation. There are no bulk accept, accept-all, silent accept, session-wide grant or automatic retry
controls. An answer that arrives after takeover or another response is rejected.

## Claude workflow

`/fleet:inbox` contains the controller procedure. The lower-level commands are:

```sh
node plugins/fleet/scripts/fleet.mjs inbox --workspace . --json
node plugins/fleet/scripts/fleet.mjs inbox --workspace . --request <returned-request-id> --json
node plugins/fleet/scripts/fleet.mjs inbox-propose --stdin --json
node plugins/fleet/scripts/fleet.mjs inbox-answer --stdin --json
```

Proposal input:

```json
{
  "workspacePath": "/absolute/project",
  "id": "<returned-request-id>",
  "revision": 1,
  "proposal": {
    "note": "Prefer the existing deterministic parser.",
    "result": {"answers": {"approach": {"answers": ["Existing parser"]}}}
  }
}
```

A successful proposal advances the revision but does **not** answer Codex. Only a human-reviewed,
non-secret technical question can be delegated. The human reviews its actual content; a heuristic
classification never grants authority. Delegation expires within 90 seconds, is scoped to one request
and revision, and permits one exact answer. Targeted inspection exposes the delegated capability to
the local controller; summary lists do not. `inbox-answer` takes `workspacePath`, `id`, `revision`,
`delegationToken` and `result` through stdin/file, never as a shell-expanded token argument.

A bounded `inbox-wait --timeout-ms 60000 --json` observer can run as one host background task for
active jobs. It returns a cursor plus only actionable requests; `--after <cursor>` suppresses repeats.
Proposals do not trigger self-sustaining notification loops. This local wait performs no inference;
a subsequent Claude turn triggered by the host still consumes the normal Claude budget.

The shipped controller instructions forbid using internal operator endpoints or simulating keyboard
input to manufacture human consent. Compact status observations include pending counts; this
package does not install an always-on Claude wakeup loop. Use the inbox skill at an intervention point.

## Admission and protocol support

New lane contracts may set **`interactive: true`**. This explicitly requests `on-request` approval
behavior from Codex while preserving the lane's sandbox and network profile. It does not itself grant
any additional permission. Without the field, existing `never` approval behavior remains unchanged.
The flag survives persisted continuation; old live questions themselves do not survive broker restart.

Supported server requests (validated against generated Codex 0.153.4 type definitions and official
[app-server documentation](https://developers.openai.com/codex/app-server)):

| Method | Handling |
| --- | --- |
| `item/tool/requestUserInput` | Bounded non-secret question/option input; exact answer map; explicit per-question technical delegation after human review |
| `item/commandExecution/requestApproval` | Human acceptance or rejection of the displayed request; never an amended execution policy or `acceptForSession` |
| `item/fileChange/requestApproval` | Human acceptance only when the same-turn proposed changes and complete request are available; otherwise deny-only |
| `item/permissions/requestApproval` | Human grant of exactly the requested known profile, or an empty grant; always `scope: turn` |

Network approval context is displayed as part of the full request. Such an upstream request may cover
multiple queued operations to the same destination; do not interpret it as a guarantee of a single
network packet or one shell command. A turn-scoped permission grant can affect the remainder of that
turn. These are explicit new human-reviewed grants, not silent expansions of the original lane record.
App connector consent can arrive as user input. Approval-shaped options are marked as approvals and
cannot be delegated. Other questions still require individual human classification; wording alone
cannot prove a question is free of side effects.

MCP URL/form elicitation, auth token refresh, attestation, dynamic tool calls and legacy approval
methods remain unsupported and fail closed. Secret-input questions use the owning Codex client.
A request that has lost its current owned turn cannot be answered. Unsupported or malformed inbound
messages get a bounded error, never a fabricated successful response.

## Concurrency, lifecycle and privacy

Every preview binds a random one-use confirmation to the request ID, revision and exact normalized
action for 60 seconds. No `actor: human` field can substitute for it. A proposal or takeover advances
the revision and invalidates older previews/grants. Before yielding to the transport, a reply changes
the entry to `sending`; a competing reply is rejected. The JSON-RPC reply uses the original wire ID,
including numeric zero. Numeric and string IDs remain distinct.

`sent` is transport handoff, not server execution success. `serverRequest/resolved` means answered or
cleared, including server lifecycle cleanup; it does not independently verify work. Failed/uncertain
reply delivery is not retried. Completion, interruption, disconnect or a 15-minute request deadline
invalidates pending work. Timeout sends a fail-closed error once. No pending approvals are replayed on
restart. Retired IDs are kept as bounded tombstones to reject replay; the per-connection identity budget
is 4096 and requires explicit reconnect when exhausted. Conflicting reuse closes the broker rather
than answering the wrong request.

At most 64 unresolved requests and 128 visible live/history records are kept. Raw request details,
proposals, answers, preview tokens and delegation grants are not written to Fleet's durable state.
After terminal resolution they are discarded from live entries too; bounded identity/state/digests
remain. Only numeric pending counts flow into ordinary lane state and compact controller status.
The app-server and model provider have their own retention policies; Fleet cannot change those.

**Trust boundary:** this is a local cooperative controller, not an OS-level sandbox between Claude
Bash and the human. The authenticated supervisor protects workspace routing and accidental/stale
operations; it does not cryptographically prove that a person, rather than another process with the
same user's credentials, clicked the UI. A hostile process with the same OS privileges can imitate
local operator calls. Do not expose the supervisor socket/token to untrusted tools or remote users.
For adversarial-agent isolation, a separate privileged approval service / OS user is required.

## Smoothness and evidence

Inbox reads and mutations do not block the keyboard queue. There is one in-flight inbox operation per
view. Escape works while an operation is pending, generations discard stale view updates, drafts are
not periodically overwritten, and a delayed mutation produces an uncertainty warning instead of a
resend. List polling occurs only while the inbox list is visible; no separate model polling daemon is
introduced. Terminal output is bounded and neutralizes control sequences.

The regression suite includes actual JSONL app-server transport plus authenticated local IPC for
request -> proposal -> human preview -> delegation -> exact same-turn reply, and tests stale replies,
concurrent responders, takeover, timeout, disconnect, malformed input, secret rejection, permission
scope, file-diff availability, terminal dimensions, keyboard context, and slow/late responses. The
fixture uses no paid model, account, browser or production operation. A real-account canary is still
required before calling this installed-runtime behavior proven.
