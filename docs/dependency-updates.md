# Dependency updates (H4 / Issue #8)

## Hosted activity

[Dashboard #168](https://github.com/apaapapapapa/FantasySimulation/issues/168) verifies
bot activity, not updates/automerge. Do not repeat activation or add another bot.

## Owner-approved minor exception

The owner's 2026-09-26 request permits hosted Renovate's unattended **minor-only**
merges (`1.2.0 -> 1.3.0`) without agent review receipts, superseding #8's blanket
prohibition. H4's checked configuration and main Ruleset govern this exception.
Agent/manual merges, even of bot PRs, still require review and `harness delivery`.
Never fabricate review evidence.

The final rule permits stable 1.x-or-later minors, including full-SHA-pinned Actions.
Major, patch, pin/digest, standalone lockfile, vulnerability-alert and 0.x updates
remain manual. Vite+/bundled Vitest, Node/pnpm/types and Rapier/WASM also stay manual
for compatibility/determinism review. Minor/patch proposals are separated.

Renovate squash-merges PRs on a later run after CI succeeds and the branch is current: `platformAutomerge: false`, `automergeType: pr`,
`automergeStrategy: squash`, `rebaseWhen: behind-base-branch`. GitHub's native
auto-merge toggle is unnecessary. `ignoreTests` and `internalChecksAsSuccess` stay
false. Never bypass status checks, unresolved threads, PRs or the main Ruleset.
H4 rejects broader permissions and nested safety overrides.
See [Renovate automerge](https://docs.renovatebot.com/key-concepts/automerge/).

Proposals need no weekly window or Dashboard approval; limits remain two PRs/hour
and three concurrently. Keep `config:best-practices` and release-age safeguards.
Hosted execution, not green CI, determines merge timing. Standalone lockfile
maintenance is Monday 00:00-04:00 Asia/Tokyo; version-update lockfiles are unrestricted.
Vulnerability proposals retain no pre-approval/time window, but manual merges.

[Dependency policy](../.github/workflows/dependency-policy.yml) runs the pinned official
validator and H4 tests without write tokens or App secrets; it is not the update bot.

## Manual toolchain review and acceptance

Review Vite+, alias, peer override, bundled Vitest, lockfile and compatibility record
together; never advance reviewed records automatically. Vite+ 0.3.3 pins Vitest and
`@vitest/*` to 4.1.11. Node/pnpm/types retain exact pins and a matching engine range.
Refresh pnpm shims with `vp install --force --frozen-lockfile` after a pin change.
Even Rapier patches need physics version, exact WASM hash, engine identity and
fixed-seed replay evidence. Run `engine:check`; do not regenerate fixtures to pass.
All updates require [Linux CI](development/ci.md).

[#8](https://github.com/apaapapapapa/FantasySimulation/issues/8) retains actual
bot/toolchain and Rapier upgrades, eligible minor automerge and first GitHub
`schedule` runs. Audit bot merger identity and exact successful CI; configuration
validation is not a real merge. No downgrade/prerelease may manufacture evidence.
Manual runs are not scheduled runs. Follow the [completion protocol](issue-completion.md)
only after all items pass. See [security checks](security.md) for H4 and protection.
