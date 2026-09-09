# Lane contracts

Every lane receives one immutable, bounded contract. The root Fleet JSON contains runtime fields; the
lane `prompt` contains the human-readable work contract. Stable workspace rules that are identical
across sibling lanes belong in root `sharedContext`; do not paste the same multi-kilobyte rules into
every lane prompt.

## Required prompt sections

1. **Objective** — one observable outcome.
2. **Inputs** — exact files, URLs, artifacts, prior evidence, and assumptions.
3. **Exclusions** — actions and surfaces that remain out of scope.
4. **Authority** — plain-language mirror of the machine authority object.
5. **Capability evidence** — smoke result, environment, time, and limitations.
6. **Deliverable** — exact output shape and destination.
7. **Verification** — distinguish start gates, lane completion gates, and controller-owned checks.
8. **Stop conditions** — ambiguity, denial, conflicting evidence, dirty state, or unsafe mutation.
9. **Cleanup** — only lane-owned temporary resources and processes.
10. **Execution posture** — the admitted Fleet contract is authorization to execute and verify the
    objective now. Do not stop at a plan or ask for redundant approval. Never widen authority; report a
    genuine missing authority, external effect, input, or user choice to the controller.

Every execution prompt also states that the controller owns Git commits; lanes must not commit or amend.
On Windows PowerShell 5.1, do not use `&&`; run commands separately and inspect each result. Persist
intermediate findings before long-running suites. If the sandbox blocks a build, worker spawn,
database target, browser, or dev-server command, return the exact blocked check as a controller-owned
verification request instead of claiming it passed.

For mutation testing, a green result is evidence only after the mutation itself is proven to have been
applied. On Windows, keep scratch/backup files under the workspace or another path whose semantics were
actually verified; never assume `/tmp` maps to the process-visible temporary directory. A verification
check must measure behavior rather than pin incidental source text unless exact source text is itself the
contract. Do not make one gate green by moving behavior into another gate's known blind spot.

Visual/render claims require browser or visual evidence. If that capability is absent, report the check
as `skipped` or `blocked`, not `passed`. Likewise, a local SQLite/unit/mocked gate is not PostgreSQL or
provider evidence. A read-only Python verifier that should not write pytest caches may use
`PYTHONDONTWRITEBYTECODE=1` and `pytest -p no:cacheprovider` when those options fit the repository.

Prompts are bounded by the Fleet 128 KiB contract input limit. Prefer references to repository files
over copying large context. Never include credentials, cookies, personal data, hidden reasoning, or raw
private logs.

## Machine contract

```json
{
  "schemaVersion": 1,
  "workspacePath": "/absolute/workspace/path",
  "modelPolicy": "runtime",
  "sharedContext": "Stable workspace rules shared by sibling lanes.",
  "limits": {
    "maxActive": 3,
    "maxWritersPerCheckout": 1,
    "staggerMs": 250
  },
  "confirmationRef": null,
  "lanes": [
    {
      "id": "bounded-stable-id",
      "role": "investigator",
      "label": "Short operator-visible label",
      "model": "gpt-6-astra",
      "effort": "high",
      "prompt": "Objective: ...\nInputs: ...\nExclusions: ...",
      "verificationPlan": {
        "start": ["Preconditions that must be true before useful work can start"],
        "completion": ["Checks the lane should complete before claiming accomplished"],
        "controller": ["Checks that must run outside the lane sandbox/environment"]
      },
      "authority": {
        "sandbox": "read-only",
        "network": "off",
        "browser": { "inspect": false, "mutate": false },
        "process": { "start": true, "stopOwned": false },
        "database": { "read": false, "write": false },
        "image": { "generate": false, "edit": false },
        "externalEffects": {
          "send": false,
          "payment": false,
          "deploy": false,
          "delete": false
        },
        "retry": false
      },
      "checkoutKey": "shared-checkout",
      "priority": "normal"
    }
  ]
}
```

Use `modelPolicy:"runtime"` only when the connected runtime catalogue was actually queried. Existing
compatibility-snapshot models may omit the field. `modelPolicy` is a root property; putting it inside a
lane is invalid and Fleet reports the correct location. `sharedContext` is also root-only and is bounded.

Use the platform's absolute workspace path; never hardcode a user's home path in reusable guidance.
`process.start` authorizes Fleet to start that Codex lane, not arbitrary child processes inside the
task. A preflight may still prove that the selected sandbox cannot spawn a nested build worker. That is
an environment boundary to report before spending a model turn, not authority to weaken the sandbox.

`confirmationRef` may be omitted or `null` for a safe read-only contract. A filesystem write, image
generation/edit, browser mutation, database write, or external-effect grant requires a non-empty root
`confirmationRef` from the exact visible plan.

The machine `role` field requires an exact literal. Allowed values are `investigator`,
`current-web-researcher`, `planner`, `implementer`, `browser-qa-operator`, `visual-analyst`,
`integrator`, and `independent-verifier`. Natural-language shorthand such as `verifier` is descriptive
prose, not a valid machine role. Use `fleet.mjs init --list --json` to inspect the maintained template
gallery instead of guessing enum values.

For a model not in the compatibility snapshot, query the connected runtime:

```text
fleet models --refresh --workspace <workspace> --json
```

Use the returned exact `model` and `effort` and set root `modelPolicy` to `runtime`. Never invent an
alias or silently substitute a model after refusal. Refresh is allowed only while the runtime is idle.

When using `start --contract`, the path must be a regular, non-symbolic-link file containing exactly one
UTF-8 JSON object no larger than 128 KiB. Mutable authority requires a non-empty root `confirmationRef`;
placing approval prose inside `prompt`, `label`, or an environment variable has no authority effect.

## Verification-plan semantics

`verificationPlan.start` is for actual prerequisites: for example a required local interpreter, a
specific generated artifact that must already exist, or capability smoke that would make the work
meaningless if absent. Do not put every final delivery gate here. A known sandbox limitation on the full
build belongs in `controller` when the lane can still do useful implementation safely.

`verificationPlan.completion` lists evidence the lane itself should attempt before claiming completion.
`verificationPlan.controller` lists checks that require an environment Fleet deliberately does not grant,
such as a host-only Windows build, real PostgreSQL target, or browser/production surface. The structured
result must preserve `passed`, `failed`, `skipped`, and `blocked`; absence of a check is never green.

When a numerical or merge rule has a meaningful empty case, state it explicitly in the contract. For
example, define what happens with zero customer queries rather than combining two formulas that only agree
for non-empty input. Describe invariants and merge behavior, not only the trigger condition that runs a
gate. Contradictory requirements should stop for clarification before implementation, not after a large
lane has spent a full context turn.

## Immutability and follow-ups

Once admitted, do not alter objective, authority, exclusions, or checkout. A clarification that stays
inside authority may be a bounded follow-up. New scope or authority requires a new preview, confirmation,
and lane contract. Never smuggle extra instructions through labels, filenames, shell interpolation, or
environment variables.

`retryOf` normally references a local lane ID. When lineage crosses physical worktrees, qualify it as
`<workspaceKey>:<laneId>` so the relationship remains machine-readable even though each workspace has a
separate ledger. A different `checkoutKey` does not create writer isolation inside one physical
workspace; real parallel writers require real separate worktrees.

## Result contract

Fleet requires `outcome`, `summary`, `workPerformed`, and `evidenceRefs`; `artifactRefs`,
`verification`, `verificationResults`, `commitRefs`, `configChanges`, `controllerRequest`, and
`stopReason` are optional with safe defaults. Allowed outcomes are `accomplished`,
`continue_within_authority`, `needs_controller`, and `blocked`. `controllerRequest` is either `null` or
`{ "kind": "...", "question": "..." }`; accepted kinds are `redundant_approval`, `new_authority`,
`external_effect`, `missing_input`, `user_choice`, and `runtime_blocker`.

`accomplished` is accepted as `complete` only when work performed, evidence references, and verification
are non-empty and consistent. Plan-only/incomplete work may continue within unchanged authority under the
bounded automatic continuation policy. If implementation appears complete but the final structured
report is malformed, Fleet gets exactly one same-thread **report-only repair** turn under read-only,
network-off authority. That repair may correct the structured report; it may not redo implementation,
run new mutation, browse, or widen authority. A second malformed result remains `outcome_unknown` and
requires reconciliation.

Do not make `outcome_unknown` directly resumable merely because the apparent cause was a small schema
error. Mutable effects are already on disk and request acceptance may be uncertain. Reconcile the artifact
and effects first, record evidence with `resolve` when appropriate, then continue or retry safely.

The final report is a claim, not proof. If the prose contains an encoding anomaly or surprising count,
check the produced artifact before changing code to match the report. The result must not include
chain-of-thought. `complete` means the lane finished its own evidence-bearing work; only a distinct
verifier can produce verified evidence.

## Logical folders

An optional lane `groupPath`, such as `backend/auth`, organizes tasks into collapsible logical folders.
It is not an on-disk worktree path or evidence of writer isolation. The rooted supervisor serializes
shared-workspace writers even when their `checkoutKey` labels differ. Real parallel worktree support
requires separate verified physical workspaces, not invented labels.