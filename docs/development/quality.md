# Architecture and TypeScript source guards

The [adoption record](https://github.com/apaapapapapa/FantasySimulation/blob/4d27971ce4ff43cf4b3c33af03af31b6d6ea124a/docs/development/quality.md)
retains the HiFiScout provenance and TS7 projection design. Current rules live in
`scripts/quality`; changes require explicit review and positive/negative/failure regressions.

Run `vp run check:quality`, or `node scripts/quality.ts` in the pinned environment.
`vp run verify` includes this read-only command. Its failures, diagnostics and executed
command are retained by the existing SHA-bound source harness and Linux CI;
`.generated/harness/quality/report.json` is an observation, not a substitute for the source report.
Exit 1 means a violation; exit 2 means missing/invalid coverage or unavailable parsing.
Focused checks may run while editing, but final delivery requires committed clean-source evidence.

## Dependency rules and TypeScript 7

Pinned dependency-cruiser owns resolution, graph construction, cycles and architectural rules.
Because its TS transpiler does not support the native TS7 API, the pinned parser emits temporary,
non-executed import-only projections for public (including types) and runtime edges. The library
resolves workspace exports, aliases and .js-to-.ts paths. No alternative parser/resolver is added.

Public edges enforce domain/engine/API/web boundaries and reject all engine cycles, including
type-only cycles. Runtime edges enforce cycle freedom throughout the project.
Engine state and geometry types depend only on domain contracts and vector types;
runtime modules consume these foundational definitions.
Engine `world` (geometry/physics), `rules` (combat derivations), `ai` (subjective
observation/decisions), and `sim` (step orchestration) depend downward in that order.
Only orchestration uses all layers; lower layers cannot import execution entry points.
ManifestBuilder may depend on execution; execution cannot import that construction module.
The public entry exposes execution and manifest construction; internal world/rules/AI/state modules
are not public. API imports (including types) use these entries. Deterministic probes use the separate
`@fantasy/engine/tooling` entry. The execution entry keeps builder edits out of identity.
Type-only edges cannot conceal a domain-to-server dependency. Rapier is allowed only in
`packages/engine/src/spatial/world/physics.ts`. Browser/domain code cannot depend on platform
builtins. Application modules cannot import development harness scripts. Core crypto is limited
to `packages/engine/src/hashing.ts`, a reserved dedicated adapter; current runtime
source uses no core crypto (only test fixtures do). The separate determinism guard
constrains any adapter to static named `createHash`, not entropy or namespace access.

The native TS project is canonical. Unsupported exports/module expressions/import-equals,
triple-slash dependencies, unsafe paths and syntax fail closed. Declarations enter the public
graph only. Only the exact vite-plus/client ambient reference in apps/web/src/vite-env.d.ts is
permitted; its imports are still checked. Test imports must resolve. Projections are deleted
after success or failure; dependency packages are not executed. TS/resolution changes require
passing guard fixtures, never a loose-parser fallback.

Tracked first-party JS/config files are rejected. Generated artifacts, dependencies and
build output are excluded; a `.js` specifier inside TypeScript is not a JS file addition.
There is no broad vendored-skill exception or blanket lint suppression.

## Engine determinism

The TS7 AST checks engine runtime (including aliases/computed access). It rejects entropy,
ambient clocks, I/O/network/DB, process/environment, dynamic code, import.meta and unreviewed
dependencies. Runtime globals use a reviewed pure allowlist; type positions/local inputs are
not ambient access. Math calls must be statically named deterministic members. Unsupported
.mts/.cts and their declarations fail as tracked source, rather than disappearing from coverage.

Only the reserved hashing adapter may statically import named createHash from node:crypto;
aliases are allowed, namespace/default imports, entropy, reexports and dynamic access are not.
Hashes need explicit inputs. Versioned PRNG and Rapier preparation stay within their existing
boundaries. Neither dependency graphs nor this conservative guard prove mathematical determinism.

## Drizzle migration verification

Drizzle Kit generates and checks `db/drizzle`. The API directly calls the official
Drizzle ORM migrator with the same SQL, journal and `__drizzle_migrations` table as
the Kit CLI. There is no application-owned runner, generation declaration, checksum
ledger, SQL parser or reset implementation. See [ADR 0005](../adr/0005-drizzle-kit.md).

`quality:migrations` runs the actual `drizzle-kit check` command and retains failures
in the ordinary quality report. Real integration tests in `apps/api/src/db/drizzle.test.ts`
verify fresh SQLite initialization, Kit/startup reexecution, legacy data adoption,
failure rollback, STRICT/JSON/kind/JSON constraints, composite keys and immutable triggers.
They run Kit generate against a disposable copy of the snapshots to detect uncommitted
schema changes. Existing API persistence and restart tests continue to run.

A Git diff test rejects edits or deletion of already committed Drizzle SQL and snapshots.
Its baseline is `MIGRATION_BASE_SHA` from the exact CI plan, or the local merge-base
with origin/main; missing baseline evidence fails rather than passing silently.
This test neither parses nor executes migrations. It is a source review policy,
not a replacement runtime checksum ledger or a guarantee against arbitrary DB drift.
All verification uses in-memory or temporary databases, never the user's DATABASE_PATH.
Initial adoption and SQLite STRICT SQL amendments require explicit review; schema
changes must not bypass migration history with `drizzle-kit push`.

## Change workflow

Use `vp test run scripts/quality` for guard fixtures and `vp test run apps/api` for
Drizzle and persistence regressions. CI uses Linux. Guard dependencies
remain dev-only; Drizzle ORM and the SQLite driver are pinned API runtime dependencies.
Engine identity uses the runtime closure from [ADR 0013](../adr/0013-execution-identity.md).
Only reachable source/dependencies affect it; unrelated tooling does not need a restamp.
Any restamp requires explicit review and unchanged independent fixtures for structural changes.
Gates, fixtures and budgets are protected from automatic repair; use reviewed engineering PRs.
