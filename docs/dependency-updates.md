# Dependency updates (H4 / Issue #8)

## Configuration and hosted activation

CI validates the single strict `renovate.json` and rejects unsafe overrides.
App authorization and [bot activity](https://github.com/apaapapapapa/FantasySimulation/issues/168)
are verified; do not request activation again. Dashboard, validator and actual
update/automerge evidence are distinct. Inspect hosted jobs if activity stops;
do not add a second bot.

## Automatic proposals and guarded minor merges

The owner's 2026-09-26 follow-up authorizes **minor-only automerge**, superseding
#8's earlier blanket prohibition. SemVer minor means `1.2.0 -> 1.3.0`, not patch.
The final package rule permits minor updates from stable 1.x or later, including
Actions while retaining full SHA pins. Other updates default to manual merging.

Major, patch, pin/digest, standalone lockfile and vulnerability-alert PRs remain
manual. So do 0.x and the Vite+/bundled Vitest, Node/pnpm/types and Rapier/WASM groups:
those paths retain their specific compatibility/determinism review requirements.
Minor/patch proposals are separated; mixed or protected toolchains must not inherit
an automatic-merge permission. See [Renovate automerge](https://docs.renovatebot.com/key-concepts/automerge/).

`automergeType: pr` and `automergeStrategy: squash` retain PR/CI history.
`platformAutomerge: false` lets Renovate itself merge on a later run after checks
succeed and the branch is current. GitHub's platform-auto-merge toggle is not needed.
`ignoreTests` and `internalChecksAsSuccess` stay false; `rebaseWhen` is
`behind-base-branch`. Never suppress status checks, enable direct branch merges,
change the main Ruleset or bypass unresolved review threads to speed this up.
Policy tests reject widening the minor rule or introducing nested safety overrides.
A passing configuration test does not prove an actual bot automerge occurred.

Normal proposals have no weekly window or Dashboard pre-approval, with at most two
PRs/hour and three concurrently. Keep `config:best-practices` and its release-age
safeguards. The hosted service decides when it runs; green CI is not an immediate
merge timer. Standalone lockfile maintenance remains Monday 00:00-04:00 Asia/Tokyo;
this does not delay lockfiles accompanying version updates. Vulnerability proposals
remain unrestricted and without pre-approval, but require manual merging.

CI uses official validator `44.106.0` and Linux toolchain policy without write tokens
or App secrets. This is not the update bot. With pinned Node:

```sh
vp run security:test
node scripts/security/toolchain.ts
pnpm --package=renovate@44.106.0 dlx renovate-config-validator --strict renovate.json
```

## Coupled toolchain and physics updates

Review Vite+, alias, peer override, bundled Vitest, lockfile and compatibility record
together; never advance reviewed records automatically. Vite+ 0.3.3 pins Vitest and
`@vitest/*` to 4.1.11. Node/pnpm/types retain exact pins and a matching engine range.
After changing pnpm, refresh shims with `vp install --force --frozen-lockfile`.
Even Rapier patches need physics version, exact WASM hash, engine identity and
fixed-seed determinism/replay evidence. Run `engine:check`; do not regenerate expected
fixtures merely to pass. All updates need Linux installation, types, tests, build,
security and applicable engine checks under the [CI contract](development/ci.md).

## Remaining acceptance

[Issue #8](https://github.com/apaapapapapa/FantasySimulation/issues/8) retains actual
bot/toolchain updates, a Rapier/WASM update and first GitHub `schedule` runs. Record
an actual eligible minor automerge separately from configuration validation.
Do not downgrade or use prereleases just for evidence; manual runs are not scheduled
runs. Use the [completion protocol](issue-completion.md) only after all items pass.
Main protection and H4 gates are recorded in [security checks](security.md).
