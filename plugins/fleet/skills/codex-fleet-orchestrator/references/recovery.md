# Recovery

Recovery preserves evidence and prevents duplicate or unauthorized effects. It never guesses that a
timeout means failure.

## OUTCOME_UNKNOWN

When an external mutation may have crossed the boundary but no terminal result was observed:

1. mark the lane `OUTCOME_UNKNOWN`;
2. freeze automatic retry and dependent mutation;
3. preserve the safe request identifier, timestamp, target alias, and last acknowledged phase;
4. query the authoritative target using read-only authority;
5. attach reconciliation evidence;
6. request separate retry authority only if absence is proven.

Never perform a blind retry after an unknown outcome. “No local response” is not proof that nothing
happened remotely.

## Broker or process interruption

Read stored lane/thread state before starting anything. Reconnect to an existing owned thread when the
runtime proves identity. Stop only an owned process whose recorded identifier and start identity match;
never kill by broad name, port, glob, or unrelated PID. If ownership is uncertain, leave it running and
report the ambiguity.

## Capability denial

Keep completed evidence, mark the denied surface, and state the smallest explicit fallback. Do not widen
sandbox/network/browser/database/external-effect authority, change account, or silently move the work to
Claude. A new route requires the user authority appropriate to that route.

## State corruption or version mismatch

Quarantine only the affected Fleet-owned state artifact. Keep read-only status where safely possible.
Do not delete workspace data or reconstruct claims from logs. For a protocol/version mismatch, block
mutating controls until compatibility is proven.

## Cleanup

Cleanup applies only to resources the lane or Fleet can prove it owns: its temporary files, isolated
worktree, socket/pipe, or exact process. Preserve modified or user-owned files. Record retained resources
and why they were not removed.

## Resume criteria

Resume only when authority remains valid, capability smoke is current, workspace/account identity still
matches, prior effects are reconciled, and the original contract still describes the requested outcome.
Otherwise create a new preview and contract.
