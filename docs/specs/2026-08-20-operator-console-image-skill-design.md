# Fleet Operator Console and Image Skill Design

## Verdict

Fleet keeps its fail-closed authority boundary, but the operator surface becomes simpler and the
ImageGen route becomes deterministic. Claude remains the controller: it can start, inspect, steer,
continue, cancel owned work, and consume results without widening a lane's admitted authority.

## Operator model

The dashboard exposes three named views: `DETAIL`, `EVIDENCE`, and `AUTHORITY`. Lane selection is
always available on the left; it is not a fourth view. `Tab` moves through the named views and the
footer says where it will go next. Internal view counts are never shown.

The masthead contains only repository/runtime health and the selected signal. KITE remains a compact,
status-driven peripheral indicator. Motion is truthful: active and awaiting-verification states can
move, terminal locked states do not, and reduced-motion always wins.

`/` opens a persistent lane-search row with the query and match count. The embedded Codex session has
role-labelled transcript rows, collapsed activity by default, a bounded scroll position, a fixed
composer, and a local slash-command palette. Local commands are visibly Fleet commands; they do not
pretend to be native Codex CLI commands.

## Session semantics

- Active owned turn: `LIVE STEER` sends through `turn/steer`.
- Completed or controller-blocked lane: `FOLLOW-UP` continues on the same Codex thread.
- `Ctrl+G`, `Esc`, or `/back` returns to the dashboard.
- `/latest` jumps to the newest transcript row.
- `/activity` toggles activity details.
- `/help` displays the local command palette.
- Excess scrolling clamps to the oldest available transcript instead of rendering an empty viewport.

## Image skill contract

An image-authorized lane (`image.generate` or `image.edit`) must discover the enabled system skill named
`imagegen` through app-server `skills/list`. Fleet accepts only an absolute `SKILL.md` path and injects
the corresponding `{type: "skill", name: "imagegen", path}` input into every image turn. Missing,
disabled, malformed, or undiscoverable capability fails before `turn/start`; Fleet never silently
substitutes another generator. Non-image lanes do not perform discovery and do not receive skill input.

## Compatibility and safety

No new authority is inferred. Existing supervisor, admission, single-writer, confirmation, immutable
terminal record, and process-ownership boundaries remain unchanged. Screen-reader and reduced-motion
modes remain first-class. The session transcript continues to hide reasoning and raw command output.
