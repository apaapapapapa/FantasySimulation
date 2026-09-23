# Development guide

## Start with the task

Read this file, then `node scripts/harness.ts context <topic>` for relevant source,
tests and authoritative docs (`context list` lists topics). Read relevant sections
only; do not preload the README, all ADRs, logs or history. Use `rg` for paths/symbols
then bounded excerpts. Read owning schemas/tests and search helpers/`test-support`
before behavior changes. See [context policy](docs/development/ai-context.md).

For implementation, fixes, CI recovery and PR delivery, apply
[fantasy-delivery](.agents/skills/fantasy-delivery/SKILL.md). Read-only requests keep
their scope. Preserve concurrent work and use small, reviewed changes.

## Boundaries

- `apps/web`: React/API client; never import server or SQLite code.
- `apps/api`: HTTP validation, configuration, persistence and runtime lifecycle.
- `packages/domain`: shared Zod schemas/types; no platform I/O. Validate untrusted JSON.
- `packages/engine`: deterministic, bounded battles; no HTTP, DB, ambient clock or
  implicit randomness. Unknown abilities fail; extend unions/exhaustive switches
  together. Preserve definitions and result snapshots; finite termination and an
  explicit draw are mandatory. Seed/version randomness. Contradictory abilities need
  defined rules, not arbitrary precedence or universal-victory claims.
- `data/spatial`: seed missing IDs without replacing edits. Follow
  [ADR 0010](docs/adr/0010-battle-version-compatibility.md) for rules/schema/sample
  changes: preserve readable saved data, version decision changes, add new rules/sample
  IDs, reject unsupported execution, review digest/corpus/fixtures together. Never
  add historical engine execution or silently convert old databases. Saved replays
  use display records ([ADR 0006](docs/adr/0006-recorded-replay.md)).
- `apps/api/src/db/schema.ts` and `db/drizzle`: official Drizzle only. Generate/commit
  SQL and snapshots; never rewrite applied migrations or use `push` in CI. Retain
  STRICT/triggers; follow [ADR 0005](docs/adr/0005-drizzle-kit.md).

## Verification and delivery

Use pinned Node/pnpm/Vite+, frozen installs, strict TypeScript and `vp run dev`.
Follow [duplication policy](docs/development/duplication.md): reuse in the owning
layer; keep test factories local/fresh and expected values independent of production.
No clone baselines, blanket exclusions or threshold increases to pass a gate.
Policy changes require explicit review and regression tests.

Run focused checks while editing and `vp run check:quality` before staging new files.
Add meaningful behavior/persistence/regression tests. Run `vp run verify` before
committing, then the skill's clean-source harness. Verify startup for runtime/build
changes. Linux CI, latest PR review and post-merge main CI remain required. Missing,
interrupted or stale evidence never passes. Keep commands/limitations accurate.
Intentional corpus inputs or mapped-test changes need a reason in the same PR;
never regenerate expected outputs from the candidate just to pass.

Use Conventional Commits; preserve squash title/`BREAKING CHANGE:` wording.
Main releases automatically; never manually bump versions or create release tags.
Bind SQL values; never commit credentials, `.env` or local DBs. Public write APIs
require authentication and deployment design; the current app is local-only.

For associated Issues, follow [completion protocol](docs/issue-completion.md): read
live scope/discussion, track remaining work, generate `harness issue-plan`, and
commit a reviewed declaration only when all acceptance items are satisfied.
Use `Refs #N`, never auto-closing wording. After merge confirm main CI, Issue
completion workflow and live closed/completed state. Never manually close or waive
external setup, failed checks or intentionally reopened work. Without an associated
Issue, do not invent one.
