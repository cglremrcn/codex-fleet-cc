# Capability routing

Capabilities are properties of the current runtime, account, configuration, and authority—not of a
role name or model. Discover and smoke each required surface before assigning it to a lane.

## Evidence states

Use these states without collapsing them:

- `available`: an executable, connector, tool, or endpoint is discoverable.
- `configured`: required configuration appears present without exposing its value.
- `smoke_passed`: the intended lane performed a minimal, non-mutating operation successfully.
- `denied`: policy, authentication, sandbox, or user authority blocked it.
- `unknown`: the observation was incomplete or ambiguous.

Only `smoke_passed` proves operational reach. A parent-Claude smoke does not prove a Codex-lane smoke.

## Discovery sequence

1. Identify the exact capability: live web search, repository write, signed-in Chrome inspection,
   image generation, database read, provider sandbox, or another named surface.
2. Inspect local availability and configuration without printing credentials.
3. Confirm the authority contract permits the non-mutating smoke.
4. Run the smallest lane-local smoke against the intended environment/account.
5. Record time, environment, account/tenant alias when safe, operation, result, and limitation.
6. Route only after the result is known.

## Routing matrix

| Need | Preferred route | Required proof | If unavailable |
|---|---|---|---|
| Repository inspection | read-only Codex lane | workspace read | keep local or stop |
| Repository change | one Codex writer | clean target + workspace-write | request authority or stop |
| Current public web | Codex live search | lane-local dated search smoke | explicit Claude fallback or stop |
| Existing signed-in browser | connected browser operator | inspect-only page/title smoke in intended profile | explicit parent-browser fallback or stop |
| Browser submission | single browser operator | inspect smoke + mutation confirmation | stop |
| Database read | read-only query lane | intended database identity + harmless query | explicit alternative or stop |
| Image/visual inspection | visual-capable lane/tool | one non-sensitive fixture | explicit parent fallback or stop |
| Image generation or edit | Codex built-in `$imagegen` (GPT Image 2) | explicit confirmation + lane-local generated artifact | explicit parent fallback or stop |
| External provider | dedicated operator | provider/tenant identity + sandbox-safe status | stop unless separately authorized |

## Fallback rules

Silent fallback is forbidden. Name the unavailable capability, its evidence state, why the preferred
route failed, what the fallback can and cannot prove, and whether it changes cost, privacy, account, or
authority. Never turn cached search into “live,” a mock into “integration,” or Claude's logged-in browser
into a Codex capability.

Re-run discovery when the runtime restarts, configuration changes, auth changes, a plugin updates, the
target account changes, or the prior smoke is stale for the task's risk.

## GPT Image 2 lanes

For image generation or editing, the Codex built-in `$imagegen` route is preferred. It uses GPT Image
2 through the user's Codex environment; do not silently substitute an API-key script, another image
provider, or a parent-Claude image tool. Generation is a metered, artifact-producing action, so it is
not a non-mutating smoke: require explicit confirmation and declare `image.generate` or `image.edit`
in the authority contract. Editing also requires the exact source image path and must preserve the
original unless replacement was explicitly approved.

The lane prompt must name `$imagegen`, the intended visual outcome, aspect ratio or dimensions,
composition, style, brand constraints, required source images, exclusions, output filename, and visual
QA criteria. Built-in output may first appear under the Codex `generated_images` directory. Copy the
selected result into a new path inside the approved workspace, verify that the file exists and has the
expected type and dimensions, and return the project-relative path as evidence. Never claim a visual
is ready from prompt text alone.

Path alone is not visual evidence for the parent. After the lane returns, parent Claude resolves the
workspace-relative path inside the approved workspace and opens the image with Claude Code's `Read`
tool. Claude performs visual QA against composition, text, brand constraints, dimensions, and
exclusions before showing or approving it. For consequential visual work, dispatch a fresh visual verifier
lane with the exact artifact path and requested criteria; parent inspection does not replace
independent verification.
