# Development guide

## Architecture

- `apps/web`: React UI and API client. Never import SQLite or server modules here.
- `apps/api`: HTTP boundary, validated configuration, database lifecycle and persistence.
- `packages/domain`: shared Zod schemas and inferred TypeScript types. No platform-specific I/O.
- `packages/engine`: bounded, deterministic battle logic. No HTTP, database, clocks or implicit randomness.
- `data/characters`: versioned sample JSON. Seeding inserts missing IDs without replacing user edits.
- `db/migrations`: append-only, checksum-verified SQL migrations.

## Workflow

1. Read the README and the relevant existing schemas and tests before changing behavior.
2. Use the pinned Node.js, pnpm and Vite+ versions. Use `vp run dev` for both apps.
3. Keep TypeScript strict. Validate untrusted JSON at the boundary with the domain schemas.
4. Add meaningful tests for new battle behavior, persistence changes and regression fixes.
5. Run `vp run verify` (or `pnpm verify`) before committing. Verify startup when changing build or runtime configuration.
6. Keep commands and limitations in the README accurate.
7. Use Conventional Commits for commits and PR titles (`feat`, `fix`, `perf`, `docs`, `chore`, etc.). Preserve the intended title and any `BREAKING CHANGE:` footer in the final squash commit. `main` releases automatically after both CI platforms pass; do not manually bump package versions or create release tags.

## Simulation invariants

- Unknown abilities must fail validation; do not silently ignore them.
- Extend discriminated unions and exhaustive switches together.
- Preserve input character definitions. Record snapshots alongside results.
- Every simulation must have a finite termination condition and an explicit draw outcome.
- Any decision-affecting change requires a rules-version bump. The 3D replacement intentionally removes pre-3D runtime/API/schema compatibility (Issue #1). New replays use immutable saved display records, not historical engine execution (Issue #10). Do not add an old-engine registry or silently upgrade old databases.
- Do not assert universal victory or create arbitrary precedence for contradictory abilities without defining the rules.
- If randomness is added, require and persist a seed plus its PRNG algorithm/version.

## Data and toolchain

- Bind values in SQL. Never commit local databases, credentials or `.env`.
- Add a new numbered migration instead of editing an applied SQL file.
- Keep `vite-plus`, its `vite` alias, the peer-version allowance and the bundled Vitest pin aligned when upgrading.
- Run both Linux and Windows CI. Do not disable failing checks to make a change pass.
- The initial app is for local development. Add authentication and a deployment design before exposing write APIs publicly.
