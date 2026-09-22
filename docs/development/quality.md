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
builtins. Application modules cannot import development harness scripts.

The root native TypeScript project is canonical. Unsupported export maps, nonliteral module
expressions, import-equals, unaccounted triple-slash dependencies, unsafe paths and syntax
errors fail rather than silently dropping edges. Source declarations/tests are not runtime
entrypoints; imported files still must resolve. Generated projections are removed even on
failure. Dependency packages are not executed by this check. Changing the native TS API or
workspace resolution requires the guard fixtures to pass, not a loose-parser fallback.

Tracked first-party JS/config files are rejected. Generated artifacts, dependencies and
build output are excluded; a `.js` specifier inside TypeScript is not a JS file addition.
There is no broad vendored-skill exception or blanket lint suppression.

## Change workflow

Use `vp test run scripts/quality` for meaningful positive and negative fixtures. CI uses
both Linux and Windows. New dependencies remain dev-only and frozen by the existing lockfile.
Manifest/lock changes conservatively affect the existing engine identity: restamp explicitly
in the engineering PR, review the diff, and keep physics/rules/Golden values unchanged when
only tooling changed. Quality gates, fixtures and budgets are protected from repair loops;
changing them requires an ordinary reviewed engineering PR. Historical engine compatibility
is not introduced.
