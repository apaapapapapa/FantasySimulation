# ADR 0014: Explicit duel scope

Status: accepted for Issue #106 D-3/R-09.

The current product, including P6, supports exactly two opposing participants.
Team/free-for-all battles are not a supported or committed requirement. Do not
extend the current single-enemy observation, targeting or victory rules by
selecting an arbitrary enemy from a larger collection.

Use a named `DuelPair` for prepared actors and one `opponentInDuel` lookup for
combat actors and movement traces. Reject missing, duplicate or extra actors.
Manifest tuples, streams 0/1, replay actor/delta limits, participant A/B controls
and first-participant camera follow intentionally retain their existing meaning.

Multiplayer requires a separate approved design: teams/hostility, target selection,
observation memory, RNG streams, simultaneous resolution and victory semantics,
plus versioned manifest/replay contracts under [ADR 0010](0010-battle-version-compatibility.md).
Do not widen saved schemas or reinterpret old duels to introduce it.

The lookup refactor preserves valid-duel ordering and decisions. Review its source
identity change under [ADR 0013](0013-execution-identity.md), retain existing fixed
corpus expectations and published data, and test invalid participant sets explicitly.

Reviewed identity transition from main `6ea1328`: `a35b7a00…` → `17d58646…`
(full SHA-256 values are in the implementation.json diff). The closure adds only
`sim/duel.ts` and changes its four callers. Dependencies, WASM, bindings and angle
table are identical. No rule/engine/schema version or corpus expectation changes;
old saved displays remain readable and old-identity execution stays unsupported.
