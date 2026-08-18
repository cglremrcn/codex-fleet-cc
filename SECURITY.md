# Security policy

Codex Fleet runs local tools against real source trees, accounts and terminals. Treat security
reports as operational issues, not ordinary support questions.

## Report privately

Use GitHub's private vulnerability reporting for this repository. Include the affected version,
platform, exact reproduction, expected boundary and observed impact. Remove prompts, credentials,
cookies, customer data and private filesystem paths before attaching logs.

Do not open a public issue for:

- command or argument injection;
- authority or confirmation bypass;
- cross-workspace data disclosure;
- credential, prompt or personal-data persistence;
- arbitrary process termination or PID-reuse problems;
- unsafe package or update behavior;
- terminal escape injection with an external effect.

If private reporting is unavailable, open a minimal issue asking the maintainer to enable a private
channel. Do not include exploit details.

## Supported versions

Before the first stable release, only the latest commit on `main` receives security fixes. After a
tagged release, the latest minor line is supported. Older development archives are not supported.

## Security invariants

- Roles never grant authority.
- User input is passed as process arguments or structured data, never a shell command string.
- Unknown capabilities deny.
- External mutations and cancellation require explicit, scoped confirmation.
- An uncertain external effect is not automatically retried.
- Process termination requires matching PID and process-start identity.
- Prompts, reasoning, tokens, cookies and raw output are excluded from persisted Fleet state.
- Support bundles are previewed, redacted and written only after an exact confirmation token.
- Setup structurally merges Claude settings and uninstall restores only values still owned by
  Fleet.
- Release archives contain only the plugin and required license/notice material.

The detailed assets, trust boundaries and residual risks are in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Disclosure process

The maintainer will acknowledge a complete report, reproduce it, determine affected versions and
prepare a regression test before publishing details. A release advisory should credit the reporter
unless they ask to remain anonymous. No fixed response-time promise is made before the project has
a staffed security rotation.
