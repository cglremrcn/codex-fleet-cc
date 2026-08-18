# Contributing

Small, evidence-backed changes are easiest to review. Open an issue before a broad redesign or a
new capability boundary.

## Local setup

```bash
git clone https://github.com/cglremrcn/codex-fleet-cc.git
cd codex-fleet-cc
npm ci
npm run verify
```

Node 18.18 remains the compatibility floor; use an active LTS release for development. Claude Code
and Codex are required only for their live integration smokes. Unit tests use local fixtures.

## Change discipline

1. State the behavior that is wrong or missing.
2. Add one test that fails for that reason.
3. Make the smallest implementation change that passes it.
4. Search for the same bug class in sibling modules.
5. Run the focused test, then `npm run verify`.
6. Keep commits narrow and use conventional prefixes such as `fix:`, `feat:`, `test:`, `docs:` or
   `ci:`.

Do not update golden terminal files to hide an unexplained rendering change. Inspect the diff at
wide, compact, narrow and monochrome sizes first.

## Pull requests

A pull request should say:

- what user-visible or security behavior changes;
- what observation proved the root cause;
- which commands passed and on which operating system;
- which platform or external surface remains untested;
- whether the change affects authority, state, terminal restoration, settings ownership,
  packaging or upstream attribution.

Never include generated testimonials, adoption claims or screenshots built from private data.

## Safety boundaries

Changes that broaden filesystem, browser, network, database or external-effect authority need an
explicit design discussion. Do not weaken confirmation binding, unknown-outcome reconciliation,
redaction, path ownership, one-writer scheduling or process-start identity checks for convenience.

Derived OpenAI runtime files live under `plugins/fleet/scripts/lib/upstream`. Preserve their
license headers and update [docs/UPSTREAM.md](docs/UPSTREAM.md) whenever their source or status
changes.

## Documentation and visuals

Documentation describes measured behavior only. A screenshot or recording must come from the real
renderer, use sanitized fixture data and match the released layout. Run:

```bash
node scripts/check-doc-links.mjs
node scripts/check-secrets.mjs
```

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
