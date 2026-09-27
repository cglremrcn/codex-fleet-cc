# Operator clarity and harness acceptance review — 14 September 2026

Baseline: PR #15, `62551b8e671f5b2596582c8fc2fced3f3e57ce78`, stacked on PR #14.
This change does not merge either PR, publish a release, upgrade an installed runtime,
or claim that authenticated live Fleet operation has been validated.

## What changed

The dashboard now answers two separate questions persistently: **VIEW [W]** is where
the inventory comes from; **GROUP BY [G]** is how that inventory is arranged. Both
remain visible down to the supported 32×8 viewport. The command center offers full
names for all nine grouping modes and all three views. `?`, `H`, and `F1` open a real,
scrollable guide instead of a clipped status message. `j/k` navigate; uppercase `K`
opens KITE. Changing scopes clears old filters/folds; loading a saved view restores
its own scope/filter/folds. No navigation action starts an inference turn.

Native Codex sessions remain observation-only, including while metadata is loading
and even if a malformed row or response claims writable control. Escape returns from
that inspection to the dashboard. Native rows do not advertise cancellation. Mouse
selection is restricted to the visible lane column and body; clicks in detail panels,
footers, hidden rows, or the narrow detail-only layout cannot change an action target.

Queued lanes no longer inflate LIVE. Pending approval/question/controller requests
count as attention even when their lane is running. Empty, filtered, partial, loading,
and stale inventory have different explanations; an empty view never proves that
all agents on the machine have stopped. Screen-reader session mode now exposes the
actual transcript. Short session layouts preserve the return control at eight rows.

KITE has a stronger seven-row silhouette and readable compact face, with a complete
ASCII fallback. Unknown effects and approvals outrank background activity when no
individual lane is selected. A selected lane retains its own reported posture.
COMPLETE remains distinct from VERIFIED; motion never supplies progress percentages,
a verification verdict, or an authorization decision. Reduced-motion, hidden-mascot,
and screen-reader settings remain supported.

Snapshot refresh now retains one underlying unresolved read per scope after a UI
deadline. Rapid scope cycling joins pending reads rather than stacking requests.
Late results only apply to the current eligible scope; malformed/failed reads remain
stale. Disposal clears deadlines and signals cancellation. Adapters may ignore the
AbortSignal: this is not a claim that remote work was forcibly terminated. The initial
pre-console read remains a separate bounded startup operation; this change does not
replace the runtime with a global event-subscription architecture.

## Reproducible evidence and limits

Focused tests run without an authenticated model account:

```sh
node --test tests/operator-clarity.test.mjs tests/operator-harness.test.mjs
```

The normal `npm test` glob includes both files; no special flags, loaders, dependencies,
or production test doubles are committed. Keep the existing full `npm run verify`,
PTY, security, admission-race, intervention and runtime suites as merge gates. Four
reviewed renderer goldens change intentionally with the dashboard chrome.

Local authoring evidence: 14 pure-module tests passed, including 486 dashboard
scope/group/size/observation combinations, tiny sessions, ASCII/motion constraints,
read-only controls, request accounting and accessible transcripts. Eleven controller
regressions passed using the real changed controller/renderer/overlay with isolated
unrelated integration dependencies. The same deferred-read scenario accumulated six
unresolved reads on the baseline and one on the patch. These local controller results
are unit evidence, not full-repository or live integration results. The local Node
was 22.16.0, below the repository's supported minimum; CI on supported Node versions
remains necessary. Consult the PR's exact-head CI results, not this static note, for
the final merge gate. No authenticated live smoke was run during this review.

Before release, use a disposable profile and the documented live-smoke procedure
with explicit account consent. Verify workspace → projects → native → workspace,
100-agent navigation, same-thread follow-up, approval versus question handling,
unknown-effect recovery, supervisor restart and original-editor return. Source
changes alone do not update an installed terminal plugin.

## Next architectural gates — not implemented by this UI/reliability change

**Revision-bound verification.** Bind a verdict to the actual source revision/tree,
contract digest, command/environment evidence and verifier identity. Editing the
verified tree must invalidate readiness. Acceptance: a verdict for revision A cannot
mark revision B releasable, including after restart or delayed event replay.

**Physical worktree scheduling and ownership.** Logical folder/checkout labels are
not filesystem isolation. Require canonical-root/resource leases, explicit writer
admission, fencing against retired owners, and evidence-based recovery. Acceptance:
two independent controllers cannot admit conflicting writers; a retired lease cannot
mutate a new owner's workspace. Do not add automatic destructive recovery.

**Quality-and-cost evaluation.** A repeatable task corpus should measure accepted
outcomes, regressions, interventions, wall time, reported tokens and retries per
accepted change. Compare bounded model/effort policies on the same tasks; escalate on
failed acceptance evidence, not by default. Subscription quota and dollar cost must
not be inferred from token counters. Never relax authority or verification to improve
an apparent success rate.

These are separate production changes with their own data migration, negative tests,
recovery cases and live canary gates—not features silently claimed by a better mascot.
