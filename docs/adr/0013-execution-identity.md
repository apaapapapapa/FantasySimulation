# ADR 0013: Execution-only engine identity

Status: accepted; owner approved this design in ChatGPT on 2026-09-24 (Issue #106 D-1).
Refs #106 R-01/D-4 and [compatibility](0010-battle-version-compatibility.md).
This ADR changes no executable, digest, fixture or saved data by itself.

## Decision

Use a versioned `source-closure-v2` SHA-256 input, limited to executable source
closure, resolved runtime dependencies, pinned Node and physics assets.
Unrelated dependency/script/API/Web/publication/sample changes must not invalidate
saved BattleSpecs or confirmed-result cache entries.

The canonical payload contains sorted POSIX-relative paths with LF-normalized
UTF-8 source/JSON bytes, dependency identities and physics asset hashes. Discovery
order and CRLF do not affect the result. This is file-level source identity, not
semantic equivalence: edits within a reachable file can still require a restamp.

- Roots: prepareBattle, simulate, runBattle/runPreparedBattle and result finalization,
  through a narrow engine execution entry. Include their complete runtime import
  closure: static imports, runtime re-exports, side effects and literal dynamic
  imports, including JSON. Erased `import type`/`export type` add no edge; inline
  `{ type T }` retains module side effects under verbatim syntax and adds an edge. Use the pinned TS
  parser/resolver, not regular expressions or a hand-maintained source allowlist.
- Resolve workspace exports to concrete files; enforce repository containment and
  ESM/package export assumptions. Unknown/unresolved/ambiguous imports, nonliteral
  dynamic loading, unsupported module forms or missing inputs fail closed. Traverse
  cycles once; never quietly drop an edge. No HTTP/DB/Web/sample module is permitted
  in the execution closure.
  Source capture uses Linux `/proc/self/fd` to bind containment to the opened file,
  then bounds reads on that descriptor; parent-path swaps cannot approve another file.
  Missing descriptor inspection fails closed. Other capture platforms are unsupported,
  consistent with current Linux verification; the canonical payload is unchanged.
- Resolve external runtime dependencies recursively from frozen pnpm importers and
  snapshots, retaining package name, resolved version/peer identity and integrity.
  Initially this is Rapier and domain's Zod. Relevant transitive dependencies are
  included; unrelated lock entries, importer scripts and dev-only tools are not.
  Missing integrity, installed/pinned version mismatch or unsupported lock format
  fails. Do not assume all future runtime dependencies remain these two packages.
- Include exact `.node-version`, physics profile, angle table and actual Rapier WASM
  and binding hashes. Check the executing Node pin and installed artifacts.
  `implementation.json` is the generated output and is excluded to avoid recursion;
  its non-digest identities are derived from those same checked inputs.
- Exclude whole root/package manifests, tsconfig, lockfile and the generator itself
  from the digest. Selected export resolution/dependency identity remains validated.
  Changes to discovery/resolution/build assumptions remain explicitly reviewed
  quality-policy changes; a narrower digest is not permission to weaken CI.

## Module boundaries

Add a domain execution entry for definitions/manifest, records/stream, canonical,
random/numeric and pure rule derivations. Engine runtime imports only that entry;
HTTP, batch, publication and replay validation keep separate entries.
Dependency-cruiser and regression fixtures enforce these boundaries.

Move catalog/published-rules/tactical-samples/sample builders to a samples workspace
package depending on the public engine API. Update callers; never import samples
back into engine execution. Preserve every published ID/hash and every byte under
`data/spatial`. Engine public tooling/builders remain distinct from execution roots.

## One-time transition and acceptance

Approval authorizes this algorithm migration, not automatic expected-output repair.
The implementation PR records old/new digest, payload inputs and exact baseline/head,
with explicit review of the single restamp. Identical decisions need no rules/engine
version bump; any decision change requires a separate versioned change under ADR 0010.
The identity algorithm has its own v2 tag.

The [reviewed transition receipt](https://github.com/apaapapapapa/FantasySimulation/blob/4d27971ce4ff43cf4b3c33af03af31b6d6ea124a/docs/adr/0013-execution-identity.md#one-time-transition-and-acceptance)
retains the baseline, old/new digests, input/package counts and unchanged physics/data evidence.
`node scripts/engine-identity.ts --inputs` prints the current canonical payload.

That one restamp changes new simulationHash values. Existing immutable specs/results
are not rewritten: saved results/replays stay readable, and old-identity retry/recovery
remains unsupported (409). No historical engine, digest alias or automatic migration
is introduced. Future unrelated changes preserve v2 identity; reachable source changes
still need a reviewed restamp. This does not promise runtime-refactor cache stability.

Required regressions: runtime source/dependency/integrity/Node/physics changes alter
identity; Web/API/publication/samples/dev dependencies/root scripts do not. Test nested
imports/re-exports/JSON/transitives and equivalent file enumeration/line endings.
Missing files/integrity, invalid lock data, unresolved/dynamic imports and stale output
must fail rather than stamp a partial graph. Verify built Worker and direct-engine
results against independent existing fixtures and fixed corpus inputs/event/trajectory/
TS/physics digests. No expected-value regeneration to make tests pass.

Delivery follows [fantasy-delivery](../../.agents/skills/fantasy-delivery/SKILL.md), including
clean-source and Linux PR/main CI. R-05 D-2 is specified in [ADR 0006](0006-recorded-replay.md).
Other #106 structural work is tracked in the Issue's acceptance checklist.

## Document budget (D-4)

Keep total 170,000 bytes, including ADRs, and all existing per-document/entry limits.
Condense completed evidence into immutable history links while retaining current
contracts/reproduction commands. Exact total-boundary and overflow tests protect the
budget. R-01/P5 use reclaimed space; no exclusions or higher thresholds are proposed.
