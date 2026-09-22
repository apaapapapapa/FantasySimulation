# Architecture and TypeScript source guards

Issue #7 adapts HiFiScout at `36aaf69d3f7a61195af4e85a468514dfbb1ecc80`,
`.dependency-cruiser.json` and `scripts/check-no-first-party-js.ts`. Catalog/crawler rules,
Cloudflare dependencies and vendored skills are not imported.

Run `vp run check:quality`, or `node scripts/quality.ts` in the pinned environment.
`vp run verify` includes this read-only command. Its failures, diagnostics and executed
command are retained by the existing SHA-bound source harness and both-platform CI;
`.generated/harness/quality/report.json` is an observation, not a substitute for the source report.
Exit 1 means a violation; exit 2 means missing/invalid coverage or unavailable parsing.
Focused checks may run while editing, but final delivery requires committed clean-source evidence.

## Dependency rules and TypeScript 7

The pinned dependency-cruiser 18.1.0 owns module resolution, graph construction, cycle
analysis and architectural rules. Its original TS transpiler does not support our native
TypeScript 7 API, so the pinned TS7 AST produces two temporary **non-executed** import-only
projections: all dependencies and runtime dependencies without type-only edges. The library
resolves both graphs, including workspace exports, TS path aliases and `.js` to `.ts`
resolution. No second graph resolver, older TypeScript, parser package or compiler is added.

Public edges enforce domain/engine/API/web boundaries; runtime edges enforce cycle freedom.
Type-only edges cannot conceal a domain-to-server dependency, but a legitimate reverse
physics type reference is not a runtime cycle. Rapier is allowed only in
`packages/engine/src/spatial/physics.ts`. Browser/domain code cannot depend on platform
builtins. Application modules cannot import development harness scripts. Core crypto is limited
to `packages/engine/src/hashing.ts`, a reserved dedicated adapter; current runtime
source uses no core crypto (only test fixtures do). The separate determinism guard
constrains any adapter to static named `createHash`, not entropy or namespace access.

The root native TypeScript project is canonical. Unsupported export maps, nonliteral module
expressions, import-equals, unaccounted triple-slash dependencies, unsafe paths and syntax
errors fail rather than silently dropping edges. Declarations participate in the public graph; their edges do not enter the runtime
graph. Only the exact `vite-plus/client` type reference in `apps/web/src/vite-env.d.ts`
is an approved compiler ambient reference; additional imports in that file are still
checked. Tests are not runtime entrypoints; imported files still must resolve. Generated projections are removed even on
failure. Dependency packages are not executed by this check. Changing the native TS API or
workspace resolution requires the guard fixtures to pass, not a loose-parser fallback.

Tracked first-party JS/config files are rejected. Generated artifacts, dependencies and
build output are excluded; a `.js` specifier inside TypeScript is not a JS file addition.
There is no broad vendored-skill exception or blanket lint suppression.

## Engine determinism

The native TS7 AST independently checks engine runtime source, including aliases and
computed access. `Math.random`, ambient clocks, network APIs, database/I/O imports,
process/environment access, dynamic code and unreviewed dependencies are rejected.
Use direct statically named deterministic Math members. Local engine inputs and
ordinary `self` properties are distinguished from ambient browser globals. Ambient
value references use a reviewed pure-global allowlist, not an incomplete list of
browser APIs to deny. `import.meta` is explicitly refused; type positions are not
runtime access. Unsupported `.mts`/`.cts` files (including their declarations) are
rejected as tracked source rather than silently omitted.

The sole core-module exception is a static named `createHash` import from `node:crypto`
(aliasing that import is allowed). Namespace/default imports, entropy functions,
crypto reexports and dynamic crypto access are refused. Hashes are computed from
explicit inputs. Existing versioned PRNG and the Rapier physics adapter remain valid;
WASM preparation stays in its reviewed physics boundary. Dependency graphs alone do
not prove determinism, and this conservative AST policy is not a mathematical proof.

## Drizzle migration verification

Drizzle Kit generates and checks `db/drizzle`. The API directly calls the official
Drizzle ORM migrator with the same SQL, journal and `__drizzle_migrations` table as
the Kit CLI. There is no application-owned runner, generation declaration, checksum
ledger, SQL parser or reset implementation. See [ADR 0005](../adr/0005-drizzle-kit.md).

`quality:migrations` runs the actual `drizzle-kit check` command and retains failures
in the ordinary quality report. Real integration tests in `apps/api/src/drizzle.test.ts`
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
Drizzle and persistence regressions. CI uses both Linux and Windows. Guard dependencies
remain dev-only; Drizzle ORM and the SQLite driver are pinned API runtime dependencies.
Manifest/lock changes conservatively affect the existing engine identity: restamp explicitly
in the engineering PR, review the diff, and keep physics/rules/Golden values unchanged when
only tooling changed. Quality gates, fixtures and budgets are protected from repair loops;
changing them requires an ordinary reviewed engineering PR. Historical engine compatibility
is not introduced.
