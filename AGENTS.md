# Development guide

## Architecture

- `apps/web`: React UI and API client. Never import SQLite or server modules here.
- `apps/api`: HTTP boundary, validated configuration, database lifecycle and persistence.
- `packages/domain`: shared Zod schemas and inferred TypeScript types. No platform-specific I/O.
- `packages/engine`: bounded, deterministic battle logic. No HTTP, database, clocks or implicit randomness.
- `data/spatial`: versioned sample JSON. Seeding inserts missing IDs without replacing user edits.
- `apps/api/src/db/schema.ts`: Drizzle SQLite table definitions.
- `db/drizzle`: Drizzle Kit SQL and snapshots; application startup uses the official Drizzle migrator. Never add a custom migration runner or history table.

## Workflow

For implementation, fixes, CI recovery and unfinished PR delivery, apply
[fantasy-delivery](.agents/skills/fantasy-delivery/SKILL.md). The existing source
harness is the canonical acceptance runner: verify a clean committed tree, retain
SHA-bound evidence, review the latest PR state, and confirm post-merge main CI.
Explanation-only and read-only review requests retain their requested scope.

1. Read the README and the relevant existing schemas and tests before changing behavior.
2. Use the pinned Node.js, pnpm and Vite+ versions. Use `vp run dev` for both apps.
3. Keep TypeScript strict. Validate untrusted JSON at the boundary with the domain schemas.
4. Add meaningful tests for new battle behavior, persistence changes and regression fixes.
5. Run `vp run verify` (or `pnpm verify`) before committing. Verify startup when changing build or runtime configuration.
6. Keep commands and limitations in the README accurate.
7. Use Conventional Commits for commits and PR titles (`feat`, `fix`, `perf`, `docs`, `chore`, etc.). Preserve the intended title and any `BREAKING CHANGE:` footer in the final squash commit. `main` releases automatically after both CI platforms pass; do not manually bump package versions or create release tags.
8. Use the existing source harness and finish Issue bookkeeping. Follow the Issue completion protocol below; a chat summary or merged PR alone is not completion.

## Issue completion protocol

- Read the live Issue body and discussion; check its full scope, acceptance criteria, linked PRs, sub-Issues and external setup. Keep partial progress and remaining work accurate in the Issue.
- In the final PR, generate a draft with `node scripts/harness.ts issue-plan <number>`, then add `.github/issue-completions/<number>.json` with the reviewed body hash/timestamp, summary, every acceptance item's evidence and all related PR numbers including the final PR. Declare `complete: true` and `remainingWork: []` only when the entire Issue is done. Never waive an external setting or unchecked requirement just because code is merged.
- Use `Refs #number` rather than `Closes`, `Fixes` or `Resolves` in PR/commit messages. The Issue must not close before post-merge main CI succeeds. Partial PRs must not contain a completion declaration.
- After merging, confirm both main CI and the dedicated `Issue completion` workflow. The harness updates the checklist and completion evidence and closes the Issue as `completed`; confirm the live Issue state before telling the user it is complete.
- On failures, missing permissions, changed requirements or incomplete work, leave the Issue open, record the blocker and repair/retry. Do not bypass the harness with a manual close. Respect intentionally reopened Issues and do not reclose them with old evidence.
- See [docs/issue-completion.md](docs/issue-completion.md) for declaration, retry and evidence details.

## Reuse and duplication prevention

- Before implementing, search the owning module and `test-support` for an existing operation or fixture. Reuse it or extend its narrow contract; do not copy a sibling implementation.
- Production helpers stay in the owning layer. Test factories belong in package-local `test-support`; production must never import them. Return fresh mutable test data, validate/reseal edited revisions, and retain explicit assertions/expected values in each test. Never derive expected results through the implementation under test.
- Use table-driven tests for the same behavior with different inputs. Do not replace distinct behavior with a boolean-heavy universal helper or abstract unrelated code only to satisfy a metric.
- Run `vp run check:quality` while editing, including before staging new files. `quality:duplication` is also required by `verify`, the source harness and both OS CI jobs. Fix the reported source/destination together; inspect other callers and add regression coverage.
- Do not add a growing clone baseline, blanket test exclusions, suppression comments or higher thresholds to pass the gate. Parsing/coverage/budget failures are incomplete evidence, not success. Threshold changes require an explicit policy review and regression tests.
- Follow [the duplication workflow](docs/development/duplication.md), then finish the normal source/PR delivery checks.

## Simulation invariants

- Unknown abilities must fail validation; do not silently ignore them.
- Extend discriminated unions and exhaustive switches together.
- Preserve input character definitions. Record snapshots alongside results.
- Every simulation must have a finite termination condition and an explicit draw outcome.
- Any decision-affecting change requires a rules-version bump. The 3D replacement intentionally removes pre-3D runtime/API/schema compatibility (Issue #1). New replays use immutable saved display records, not historical engine execution (Issue #10). Do not add an old-engine registry or silently upgrade old databases.
- Do not assert universal victory or create arbitrary precedence for contradictory abilities without defining the rules.
- If randomness is added, require and persist a seed plus its PRNG algorithm/version.
- `packages/engine/fixtures/spatial/corpus.json` pins fixed battle inputs and maps existing determinism tests (`vp run check:corpus`, part of `verify`). When an input or mapped test changes intentionally, update it in the same reviewed PR with the reason; never regenerate it from candidate output or mark planned coverage as done.

## Data and toolchain

- Bind values in SQL. Never commit local databases, credentials or `.env`.
- Run `vp run db:generate` after schema changes and commit the SQL plus snapshots. Use `vp run db:migrate` to apply; never use `push` in CI or rewrite an applied migration. Review SQLite `STRICT` on every table rebuild; see ADR 0005.
- Keep `vite-plus`, its `vite` alias, the peer-version allowance and the bundled Vitest pin aligned when upgrading.
- Run both Linux and Windows CI. Do not disable failing checks to make a change pass.
- The initial app is for local development. Add authentication and a deployment design before exposing write APIs publicly.
