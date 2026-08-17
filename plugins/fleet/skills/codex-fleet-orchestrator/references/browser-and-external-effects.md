# Browser and external effects

Browser access has two independent dimensions: inspecting visible state and mutating it. An existing
signed-in session is also a specific user profile/account, not a generic network capability.

## Existing session workflow

1. Identify the intended browser profile, account/tenant, environment, and allowed pages without
   exposing cookies or credentials.
2. Assign one operator to that mutable profile.
3. Run an inspect-only smoke such as reading the current page title or visible account alias.
4. Confirm it is the intended account and that the operator—not only parent Claude—can reach it.
5. Keep `browser.mutate: false` unless the user approves a precise action preview.

If the Codex lane cannot access the existing signed-in session, silent fallback is forbidden. Report
the denial and ask whether parent Claude may operate the browser instead. Do not create an account,
accept terms, change credentials, or switch tenants as a workaround.

## Mutation boundary

Typing into a local unsent field can still expose data; clicking submit, save, send, purchase, deploy,
delete, approve, invite, publish, or upload is an external mutation. Before mutation show:

- target account/tenant/environment;
- exact action and payload class;
- expected visible effect;
- idempotency/reconciliation method;
- rollback or irreversibility;
- cleanup responsibility.

Require explicit confirmation tied to that preview. Separate grants exist for browser mutation,
database write, message send, payment, production deploy, and delete. One never implies another.

## QA rules

Browser QA records viewport, browser/runtime, auth state category, path, interaction, expected result,
observed result, and safe screenshot/evidence reference. Test desktop and mobile only when in scope.
Never capture tokens, cookies, passwords, private messages, payment data, or unrelated personal data.

For forms that could send messages or charge money, stop before submission unless explicitly approved.
Use sandbox/test recipients and providers where possible, but label them accurately.

## Unknown outcomes

If a browser, send, payment, deploy, database write, or delete call times out after submission, mark it
`OUTCOME_UNKNOWN`. Do not repeat it. Reconcile through an authoritative receipt, provider status,
database record, deployment ID, or target-system observation before deciding whether retry is safe.
