# Dependency updates (H4 / Issue #8)

## Configuration and hosted activation

`renovate.json` is strict JSON. CI validates the actual file and rejects duplicate
bots, automatic merging and PR-creation approval overrides. The owner confirmed
[App authorization](https://github.com/apaapapapapa/FantasySimulation/issues/8#issuecomment-5782312771);
do not request it again. Validator success or maintainer PRs do not establish bot activity.

The owner's 2026-09-26 screenshot showed completed jobs in Silent mode, which
suppresses automatic Issues/PRs. Subsequently, the API confirmed `renovate[bot]`
created [Dashboard #168](https://github.com/apaapapapapa/FantasySimulation/issues/168)
at 11:28:43 UTC that day. Bot activity is verified; actual update-PR acceptance is
separate. Do not ask the owner to repeat activation. [Hosted mode](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/)
is independent of this file; investigate portal jobs if activity stops again.
Do not add another bot or fabricate activation evidence.

## Automatic proposals, reviewed merges

Per the owner's 2026-09-26 request and #8's no-automerge requirement, normal updates
may be proposed at any time, without Dependency Dashboard approval. The Dashboard
remains an overview, not a prerequisite to creating PRs. This includes Vite+, Node,
pnpm and Rapier groups. Keep the existing two-PR/hour and three-concurrent-PR limits
and `config:best-practices`; removing the weekly window does not bypass release-age
safety checks or control when the hosted service actually runs.

Standalone lockfile maintenance retains Renovate's weekly window, now explicit as
Monday 00:00-04:00 Asia/Tokyo, without pre-approval. This does not restrict lockfile
changes accompanying normal version-update PRs. Vulnerability proposals retain
their unrestricted schedule and no pre-approval.

All merges still require reviewed diffs and passing CI. Root, platform, vulnerability,
lockfile and package-rule automerge remain false, including nested overrides.
The main Ruleset and security/verification gates are unchanged. Creating a PR is
not approval to merge it, even for minor, patch or vulnerability updates.

CI runs official validator `44.106.0` and Linux toolchain policy without write tokens
or App secrets. It is not the update bot; its workflow schedule is independent.
With the pinned Node, run:

```sh
vp run security:test
node scripts/security/toolchain.ts
pnpm --package=renovate@44.106.0 dlx renovate-config-validator --strict renovate.json
```

## Coupled toolchain and physics updates

Review Vite+, Vite alias, peer override, bundled Vitest, lockfile and compatibility
record together. The existing group/custom manager remains; never automatically
advance the reviewed compatibility record. Vite+ 0.3.3 pins Vitest and `@vitest/*`
to 4.1.11. Node, pnpm and Node types remain a separate group with exact pins and
a matching root engine range. After a pnpm pin change, refresh existing shims with
`vp install --force --frozen-lockfile`.

Even Rapier patches require physics version, exact WASM/build hash, engine identity
and fixed-seed determinism/replay evidence before merging. Run `engine:check`;
never regenerate identities or expected fixtures merely to pass. All update PRs
need Linux frozen install, type checks, tests, build, security and applicable engine
checks under the [CI contract](development/ci.md). Windows is not required.

## Remaining acceptance

[Issue #8](https://github.com/apaapapapapa/FantasySimulation/issues/8) retains actual
bot/toolchain updates, an actual Rapier/WASM update and first GitHub `schedule` runs.
Do not downgrade or use prereleases merely to create evidence; manual runs are not
scheduled runs. Use the [completion protocol](issue-completion.md) only after all
remaining acceptance passes. Main protection and H4 report/gate integration are
already recorded in [security checks](security.md).
