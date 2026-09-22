# Dependency updates (H4 / Issue #8)

## Renovate configuration versus activation

`renovate.json5` is a strict-JSON subset of JSON5. The repository uses one
Renovate configuration and no Dependabot configuration. Installing or enabling
the hosted Renovate GitHub App is a separate repository administration step;
this PR does not claim the App is installed, authorized or running.
No suitable Renovate administration connector was available during this change.

A repository administrator must select FantasySimulation in the hosted
Renovate App, review its onboarding/dashboard, and verify an actual trial
update PR. Do not create an ordinary PR and describe it as a successful bot
trial. Record that PR, its extraction/lockfile results and all CI checks in #8.
Keep the Issue open until activation and this trial are established.

Normal updates require Dependency Dashboard approval and run before 08:00
Monday in Asia/Tokyo, at most two PRs per hour and three concurrently.
Vulnerability proposals can be raised immediately without dashboard approval,
but all merges still require human review. Root, platform, vulnerability,
lockfile and package-rule automatic merging are explicitly disabled.
The local policy also rejects a nested automatic-merge override.

The CI calls the official configuration validator at the exact version
`44.106.0`. This is a validator invocation, not a self-hosted update bot; it
receives no write token, application secret or repository credentials.
The validator and both platform toolchain checks must pass the independent
`Dependency policy / dependency-policy-gate`. Main release waits for that gate
as well as the existing verification and security workflow.
The scheduled policy check does not replace the hosted App's own schedule.

Run the regression tests and actual repository-pin check with the pinned Node:

```sh
node --test scripts/security/toolchain.test.ts
node scripts/security/toolchain.ts
pnpm --package=renovate@44.106.0 dlx renovate-config-validator --strict renovate.json5
```

## Coupled Vite+ updates

The Vite+ group covers root `vite-plus`, the Vite alias, the peer-version
override and Vitest. A custom manager covers `peerDependencyRules` explicitly.
Frozen installation still verifies the lockfile; no generated lockfile is
accepted merely because the version strings match.

For every update, review the upstream Vite+ release's bundled Vitest and
related packages, update root dependency, workspace alias, peer override,
Vitest pin and pnpm lockfile together, and update the compatibility record
with source evidence. Do not automatically advance the compatibility record
from a Renovate regex. The v0.3.3 upstream workspace was checked to pin
Vitest and `@vitest/*` to 4.1.11; the record is not a substitute for tests.
Both Linux and Windows frozen install, type checks, engine identity, tests,
build and security checks must pass on the update's current SHA.

Node, pnpm and Node types form a separate review group. Pins must remain exact;
`.node-version` must satisfy the declared root Node engine range. This simple
range policy intentionally fails on a changed format until it is reviewed.
Actual package-manager compatibility remains part of both platform install
jobs, not something inferred from a matching version string.

## Physics and future WASM updates

The Rapier package rule is reserved for the future 3D engine; this change does
not add Rapier or invent an unimplemented WASM fingerprint API. Once a physics
backend lands, even patch updates must show its version, exact WASM/build hash,
engine implementation identity and fixed-seed determinism/replay fixture diff.
Run `engine:check` and review genuine behavior changes before deliberately
regenerating an identity or fixture. Never automatically stamp away a mismatch.
Keep such updates human-approved, even when tests or vulnerability checks pass.

## Remaining acceptance

Required branch checks/review rules remain unverified because administration
reads returned HTTP 403. Adding workflows does not configure those rules.
Integration with #5/#6 report schemas and the shared gate remains tracked
separately. Existing failures in upstream stacked PRs must be resolved before
these PRs can merge; do not remove or bypass checks to activate Renovate.
