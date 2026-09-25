# ADR 0013: Execution-only engine identity

Accepted by owner in ChatGPT, 2026-09-24 (#106 D-1). Refs #106 R-01/D-4 and
[compatibility](0010-battle-version-compatibility.md). This document changes no
executable, digest, fixture or saved data.

## Identity contract

`source-closure-v2` hashes executable source closure, resolved runtime dependencies,
pinned Node and physics assets. Unrelated dependency/script/API/Web/publication/sample
changes preserve BattleSpecs and confirmed-result caches. This is file-level identity:
editing a reachable file can require a restamp despite equivalent behavior.

Canonical SHA-256 payload: sorted POSIX-relative paths, LF-normalized UTF-8 source/JSON,
dependency identities and physics hashes. Enumeration order and CRLF do not affect it.

- Roots: prepareBattle, simulate, runBattle/runPreparedBattle and result finalization
  through the narrow execution entry. Follow every static/runtime re-export, side effect,
  literal dynamic import and JSON edge using pinned TypeScript parsing/resolution.
  Erased import/export type adds no edge; inline `{ type T }` retains module side effects
  under verbatim syntax and adds an edge. No regex discovery or manual source allowlist.
- Resolve workspace exports to concrete contained files with checked ESM/export assumptions.
  Unknown/unresolved/ambiguous imports, nonliteral loading, unsupported forms and missing
  inputs fail closed; traverse cycles once. No HTTP/DB/Web/sample module in the closure.
  Linux `/proc/self/fd` binds containment to the opened descriptor before bounded reading;
  parent-path swaps cannot approve another file. Missing descriptor inspection fails;
  other capture platforms are unsupported. The payload remains platform-independent.
- Recursively resolve external runtime packages from frozen pnpm importers/snapshots,
  retaining names, versions/peer identities and integrity, including relevant transitives.
  Initially Rapier and domain's Zod; future dependencies are not limited to them. Missing
  integrity, installed/pinned mismatch or unsupported locks fail. Ignore unrelated entries,
  importer scripts and development-only tools.
- Include exact `.node-version`, physics profile, angle table, actual Rapier WASM and
  binding hashes; check executing Node and installed assets. Exclude generated
  implementation.json to avoid recursion; derive its other identities from these inputs.
- Whole package/root manifests, tsconfig, lockfile and generator are excluded as hash
  inputs; their selected export/dependency resolution remains validated. Discovery,
  resolution or build-assumption changes require explicit quality-policy review.

## Boundaries and compatibility

Domain execution exports definitions/manifest, records/stream, canonical, random/numeric
and pure rule derivations. Engine runtime imports only that entry; HTTP/batch/publication/
replay validation stay separate. Dependency-cruiser and regression fixtures enforce this.
Samples owns catalog/published-rules/tactical-samples/sample builders and depends on the
public engine, never the reverse. Preserve all published IDs/hashes and data/spatial bytes.
Public engine tooling/builders remain outside execution roots.

The approved one-time algorithm migration permits no automatic expected-output repair.
The [transition receipt](https://github.com/apaapapapapa/FantasySimulation/blob/4d27971ce4ff43cf4b3c33af03af31b6d6ea124a/docs/adr/0013-execution-identity.md#one-time-transition-and-acceptance)
pins baseline/head, old/new digest, payload/package counts and unchanged physics/data.
`node scripts/engine-identity.ts --inputs` prints the current payload. Review the single
restamp explicitly. Identical decisions require no rules/engine bump; decision changes
need a separate ADR 0010 version. The identity algorithm has its own v2 tag.

The restamp changes new simulationHash values, never saved specs/results. Recorded replay
remains readable; old-identity retry/recovery stays unsupported (409). No historical engine,
digest alias or automatic migration. Future reachable edits still need reviewed restamps;
v2 promises no cache stability for runtime refactors.

## Verification and document budget

Regress runtime source/dependency/integrity/Node/physics changes versus unchanged identity
for Web/API/publication/samples/dev dependencies/root scripts. Cover nested imports,
re-exports, JSON, transitives, file enumeration and line endings. Missing files/integrity,
invalid locks, unresolved/dynamic imports and stale output fail instead of stamping partial
closures. Check built Worker/direct-engine results against independent existing fixtures
and fixed corpus inputs/event/trajectory/TypeScript/physics digests; never regenerate
expected outputs to pass.

[Delivery](../../.agents/skills/fantasy-delivery/SKILL.md) requires clean-source and Linux
PR/main CI. R-05 D-2 follows [ADR 0006](0006-recorded-replay.md); other #106 work stays in its
acceptance list. Total documentation remains 170,000 bytes with existing document/entry
limits. Condense completed evidence into immutable links; retain current contracts and
reproduction commands. Exact-boundary/overflow tests protect this budget. R-01/P5 use
reclaimed space, with no exclusions or higher thresholds.
