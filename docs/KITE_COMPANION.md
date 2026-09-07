# KITE companion v2

KITE projects the selected agent's reported state, not model intelligence, a completion percentage,
or proof of successful work. `K` (uppercase) or the command center opens its local operator panel;
lowercase `k` still moves up, and typing either letter in an input does not activate a shortcut.
Clicking the mascot opens the same panel. The panel links to attention-first sorting, refresh, motion
and visibility controls. It does not start a model turn.

The seven-row avatar and compact badge distinguish idle, observed, queued, starting, running,
awaiting-verification, verified, question, approval, unclassified request, blocked, failed, cancelled,
interrupted, unknown-outcome and stale-observation states. Typed request counts take precedence over
activity; a stale observation overrides a previously successful state. Unknown request types are never
presented as safe technical questions. The state label remains textual in monochrome and ASCII modes.

Movement is deterministic at the existing capped refresh cadence. No private timer, random progress,
model invocation or telemetry is added. Hidden mascots, reduced-motion preferences, screen readers,
stale observations and states requiring intervention do not animate. A finished worker remains
**awaiting verification**, not verified. Empty views are idle, not fictitious queued work.

## Responsiveness

Session metadata reads are asynchronous and single-flight. The composer and Escape remain responsive
while a read is pending. A generation guard discards a late response after close, scope change, reopen
or console disposal. A UI read deadline reports the stale read without issuing unlimited replacement
requests; the broker's request deadline remains the transport bound. Tick events coalesce instead of
accumulating behind a slow operation. In-flight mutations are not automatically retried.

## Validation boundary

Fixtures exercise all states, reduced motion, ASCII, screen-reader behavior, terminal sizes, local
keyboard actions and delayed/out-of-order session reads. These tests are not a live-account throughput
benchmark. The shared intervention inbox is a separate layer: KITE can display typed pending counts,
but does not grant authority or invent requests.
