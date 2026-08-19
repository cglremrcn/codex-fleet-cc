# Lane contracts

Every lane receives one immutable, bounded contract. The root Fleet JSON contains runtime fields; the
lane `prompt` contains the human-readable work contract.

## Required prompt sections

1. **Objective** — one observable outcome.
2. **Inputs** — exact files, URLs, artifacts, prior evidence, and assumptions.
3. **Exclusions** — actions and surfaces that remain out of scope.
4. **Authority** — plain-language mirror of the machine authority object.
5. **Capability evidence** — smoke result, environment, time, and limitations.
6. **Deliverable** — exact output shape and destination.
7. **Verification** — commands or observations the lane must run before claiming completion.
8. **Stop conditions** — ambiguity, denial, conflicting evidence, dirty state, or unsafe mutation.
9. **Cleanup** — only lane-owned temporary resources and processes.

Prompts are bounded by the Fleet 128 KiB contract input limit. Prefer references to repository files
over copying large context. Never include credentials, cookies, personal data, hidden reasoning, or raw
private logs.

## Machine contract

```json
{
  "schemaVersion": 1,
  "workspacePath": "/absolute/workspace/path",
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
      "model": "gpt-5.6-sol",
      "effort": "high",
      "prompt": "Objective: ...\nInputs: ...\nExclusions: ...",
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

Use the platform's absolute workspace path; never hardcode a user's home path in reusable guidance.
`process.start` authorizes Fleet to start that Codex lane, not arbitrary child processes inside the
task. `confirmationRef` may be omitted or `null` for a safe read-only contract. A filesystem write,
image generation/edit, browser mutation, database write, or external-effect grant requires a non-empty
root `confirmationRef` from the exact visible plan.

The machine `role` field requires an exact literal. Allowed values are `investigator`,
`current-web-researcher`, `planner`, `implementer`, `browser-qa-operator`, `visual-analyst`,
`integrator`, and `independent-verifier`. Natural-language shorthand such as `verifier` is descriptive
prose, not a valid machine role. Use `fleet.mjs init --list --json` to inspect the maintained template
gallery instead of guessing enum values.

The machine `model` and `effort` fields are also exact literals and are validated together before
supervisor admission:

| Model | Allowed effort values |
|---|---|
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.5` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4` | `low`, `medium`, `high`, `xhigh` |

A typo is rejected with all other contract issues in the same validation response; it is not deferred
to a failing runtime turn.

## Immutability and follow-ups

Once admitted, do not alter objective, authority, exclusions, or checkout. A clarification that stays
inside authority may be a bounded follow-up. New scope or authority requires a new preview, confirmation,
and lane contract. Never smuggle extra instructions through labels, filenames, shell interpolation, or
environment variables.

## Result contract

Require a verdict, evidence references, verification performed, limitations, residual risks, cleanup
state, and exact terminal status. The result must not include chain-of-thought. `complete` means the lane
finished its own work; only a distinct verifier can produce verified evidence.
