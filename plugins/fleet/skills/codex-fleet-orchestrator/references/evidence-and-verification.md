# Evidence and verification

Fleet distinguishes a worker claim from observed evidence and independently verified evidence.

## Evidence discipline

For audits and diagnosis:

1. Perform an existence check across names, synonyms, likely locations, wiring, history, and available
   project memory before declaring something missing.
2. State a hypothesis and the exact observation that would refute it.
3. Collect the refuting observation first. If refuted, say so and pivot.
4. After root cause, run a class-wide sibling search for the same pattern.
5. Record precise paths, line numbers, commands, environment, timestamps, and source URLs as applicable.

Presence alone is not evidence of execution. Prove registration, call path, runtime selection, or user-
visible wiring. Absence claims list what was searched.

## Verification matrix

| Claim | Minimum meaningful verification |
|---|---|
| Pure function | focused unit test plus relevant suite |
| Repository change | diff inspection, formatter/static checks, targeted tests |
| Integration | real sandbox/test provider or explicitly labelled mock limitation |
| Browser UX | intended viewport, session, interaction, state, screenshot/evidence |
| Database behavior | intended engine and migration/query path |
| Performance | repeated measurement in relevant environment with method |
| Current fact | dated live source retrieval and direct source fit |
| Production outcome | production observation or clearly stated unverified gate |

Test green does not imply production correct. Name the environment that actually ran and every risky
surface not exercised.

## Fresh verifier

A fresh verifier is a new lane started after the implementation/result wave ends. It is read-only by
default, does not inherit the builder's private reasoning, and is asked to falsify acceptance criteria.
It checks the diff/artifact, evidence, tests, and residual risk. Same-lane self-review never changes a
result from `complete` to `verified`.

## Report shape

1. Verdict first.
2. Evidence with precise references.
3. Confidence and what would change it.
4. Residual risks and untested environments.
5. Out-of-scope siblings.
6. Cleanup and external-effect reconciliation state.

Label each statement as observed fact, worker claim, verifier finding, or inference when the distinction
is material. Match alarm language to evidence strength. Preserve `blocked`, `failed`, `cancelled`, `interrupted`, and
`OUTCOME_UNKNOWN` as distinct terminal states.
