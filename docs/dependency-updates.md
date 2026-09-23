# Dependency updates (H4 / Issue #8)

## Renovate configuration versus activation

`renovate.json` uses strict JSON for the formatter and policy parser. The regression
test reads the real file and rejects duplicate bot configuration.
The owner confirmed the hosted Renovate App authorization in
[Issue #8](https://github.com/apaapapapapa/FantasySimulation/issues/8#issuecomment-5782312771).
Do not request authorization again. Record actual bot activity, its trial update
PR, extraction, lockfile and CI in #8. Maintainer updates and validator success
do not establish bot operation.

If no Dashboard or bot PR appears, inspect the repository's recent jobs in the
[Mend Developer Portal](https://developer.mend.io/) using the official
[troubleshooting guide](https://docs.renovatebot.com/troubleshooting/).
Check errors and `dryRun=lookup`: hosted Silent mode suppresses Issues and PRs.
The Monday schedule alone does not prove operation. Do not add another bot,
fabricate bot activity or disable approval to work around missing activity.

Normal updates require Dependency Dashboard approval and run before 08:00
Monday in Asia/Tokyo, at most two PRs per hour and three concurrently.
Vulnerability proposals can be raised immediately without dashboard approval,
but all merges still require human review. Root, platform, vulnerability,
lockfile and package-rule automatic merging are explicitly disabled.
The local policy also rejects a nested automatic-merge override.

CI uses official validator `44.106.0` without write tokens, App secrets or repository
credentials. It is not an update bot. Validator and Linux toolchain checks must
pass `Dependency policy / dependency-policy-gate`; release also requires verification
and security gates. The policy schedule does not control the hosted App's schedule.

Run the regression tests and actual repository-pin check with the pinned Node:

```sh
vp run security:test
node scripts/security/toolchain.ts
pnpm --package=renovate@44.106.0 dlx renovate-config-validator --strict renovate.json
```

## Coupled Vite+ updates

The group covers root `vite-plus`, Vite alias, peer override and Vitest; a custom
manager covers `peerDependencyRules`. Review the upstream bundled versions and
update these pins, lockfile and compatibility record together with source evidence.
Never advance that record automatically through a regex. Vite+ v0.3.3 pins Vitest
and `@vitest/*` to 4.1.11. Matching version strings do not validate installation.
Linux frozen install, type checks, engine identity, tests, build and security
checks must pass on the update's current SHA, following the current
[CI contract](development/ci.md). Windows is no longer an acceptance requirement.

Node, pnpm and Node types form a separate review group. Pins stay exact;
`.node-version` must satisfy the root engine range. Changed range syntax requires
policy review. Linux installation must verify actual package-manager compatibility.
After changing the pnpm pin, use `vp install --force --frozen-lockfile` to refresh
existing bin shims and installed package-manager metadata.

## Physics and WASM updates

Even Rapier patch updates must show the physics version, exact WASM/build hash,
engine identity and fixed-seed determinism/replay fixture diff.
Run `engine:check` and review genuine behavior changes before deliberately
regenerating an identity or fixture. Never automatically stamp away a mismatch.
Keep such updates human-approved, even when tests or vulnerability checks pass.

## Remaining acceptance

Main protection and H4 report/gate integration are complete; their current
contracts and operational acceptance are in [security checks](security.md).
Issue #8 retains actual bot/toolchain updates, an actual Rapier/WASM update and
the first GitHub `schedule` executions. Keep unavailable update paths pending;
do not downgrade dependencies or switch to a prerelease just to create evidence.
Manual runs are not scheduled runs. Use the existing
[Issue completion protocol](issue-completion.md) only after all remaining items pass.
