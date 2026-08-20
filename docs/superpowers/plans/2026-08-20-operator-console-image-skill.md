# Operator Console and Image Skill Implementation Plan

1. Add failing runtime tests for explicit ImageGen discovery/injection, missing capability refusal, and
   non-image isolation. Extend the fake app-server with the real `skills/list` response shape.
2. Add failing renderer/controller tests for three named views, visible search, truthful session mode,
   collapsed activity, slash commands, and bounded transcript scrolling.
3. Implement one runtime helper that discovers and validates `imagegen`, stores its turn input on the
   lane, and reuses it for initial, automatic, manual, resumed, and steered image work.
4. Reshape the dashboard and embedded session without changing the authority or lifecycle state
   machines. Keep wide, compact, narrow, monochrome, and screen-reader output bounded.
5. Run focused tests, full verification, real PTY smoke, and authenticated app-server smoke. Update
   goldens only after behavior tests pass.
6. Bump the release version, run package/release checks, commit, push, then synchronize the Claude
   marketplace cache and installed Ctrl+G runtime and verify byte parity.
