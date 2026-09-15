---
name: fleet-control
description: "Coordinate an existing Fleet installation from Codex or another agent using discovered JSON schemas, delta observations, bounded plans and source-bound receipts. Not for spawning nested fleets from worker tasks or granting permissions."
---

# Fleet control for repository agents

Resolve this repository's trusted absolute `plugins/fleet/scripts/fleet.mjs` entrypoint
(or a user-supplied trusted installation). Do not search private state for credentials,
change user-global settings, or assume that this repository skill installs Fleet.

Read `plugins/fleet/skills/control/SKILL.md` and its referenced workflow from the Fleet
source root. Those portable instructions are authoritative for this workflow. Replace
Claude's plugin-root placeholder with the resolved plugin path; do not copy shell
syntax blindly across platforms. Read operation schemas using `control describe`.

Use JSON stdin or `createFleetControlClient` from the matching plugin version.
Keep a single observer, wait on its cursor, and fetch only changed/needed results.
Use exact model catalogue identifiers; requests and prepared plans do not grant
permission. Unknown effects remain fail-closed. Only a current source-bound receipt
may support a current-source verification claim, and it remains reported verification,
not release authorization or proof of test adequacy. Do not start a fleet recursively
from an already admitted Fleet worker. Human approvals stay human-owned.
