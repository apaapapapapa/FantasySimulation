# ADR 0013: Execution-only engine identity

Accepted by owner in ChatGPT, 2026-09-24 (#106 D-1/R-01/D-4).
[ADR 0010](0010-battle-version-compatibility.md) owns compatibility.

## Identity contract

`source-closure-v2` hashes executable file closure, runtime dependencies, pinned Node
and physics assets. Unrelated API/Web/publication/sample/dev changes preserve specs
and caches; equivalent reachable-file edits can still require reviewed restamps.
Canonical SHA-256 uses sorted POSIX paths, LF-normalized UTF-8 source/JSON, dependency
identities and physics hashes; CRLF/enumeration order are irrelevant.

- Roots: prepareBattle, simulate, runBattle/runPreparedBattle and finalization through
  narrow execution exports. Pinned TypeScript follows static/runtime reexports, side
  effects, literal dynamic imports and JSON; cycles once. Erased type imports add no
  edge; inline `{ type T }` retains side effects. No regex/manual source allowlist.
- Resolve workspace exports to contained files with validated ESM/export assumptions.
  Unknown/ambiguous/unresolved/nonliteral/unsupported/missing inputs fail closed.
  No HTTP/DB/Web/sample closure. Linux `/proc/self/fd` binds containment to opened
  descriptors against parent swaps; unavailable inspection/other platforms fail.
  Payload itself remains platform-independent.
- Recursively resolve runtime packages through frozen pnpm importers/snapshots,
  retaining names, versions/peer identities/integrity/transitives (initially Rapier/Zod,
  not a fixed allowlist). Missing integrity, installed/pinned mismatch or unsupported
  locks fail. Ignore unrelated entries/scripts/dev dependencies.
- Include exact `.node-version`, physics profile, angle table, actual WASM/binding
  hashes; verify executing Node/assets. Exclude generated implementation.json from
  its own digest; derive its other identities from inputs. Whole manifests/tsconfig/
  lock/generator are not payload inputs; selected export/dependency resolution is
  still validated. Discovery/resolution/build assumptions need explicit policy review.

Domain execution owns definitions/manifest, records/stream, canonical, random/numeric
and pure rules. Engine uses only that entry; HTTP/batch/publication/replay validation
stay outside. Dependency-cruiser/regressions enforce it. Samples owns catalog/published
rules/tactical samples/builders and depends on public engine, never the reverse.
Public tooling/builders stay outside roots. Preserve published IDs/hashes/data bytes.

## Compatibility and verification

The approved [one-time transition receipt](https://github.com/apaapapapapa/FantasySimulation/blob/4d27971ce4ff43cf4b3c33af03af31b6d6ea124a/docs/adr/0013-execution-identity.md#one-time-transition-and-acceptance)
pins source/digests/counts/unchanged physics/data. `node scripts/engine-identity.ts --inputs`
prints current payload. Review each restamp: unchanged decisions need no rules bump;
changed decisions follow ADR 0010. Algorithm version remains v2. New simulationHashes
never rewrite saved specs/results/replays; old-identity retry/recovery returns 409.
No historical engine/digest alias/automatic migration or runtime-refactor cache promise.

Regress runtime source/dependency/integrity/Node/physics changes versus unrelated edits;
cover imports/reexports/JSON/transitives/order/line endings and fail-closed/stale output.
Compare built Worker/direct engine with independent fixtures and fixed corpus
input/event/trajectory/TS/physics hashes; never regenerate expectations to pass.
[Delivery](../../.agents/skills/fantasy-delivery/SKILL.md) requires clean-source and Linux
PR/main evidence. R-05 D-2 follows ADR 0006; other #106 acceptance remains separate.
[Context policy](../development/ai-context.md) retains 170,000 bytes including ADRs and
existing entry/document limits; immutable history links preserve measurements.
