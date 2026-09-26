# ADR 0015: Immutable leagues

Refs #134, #1. Daily differential publication/manual dispatch approved 2026-09-25.
Run only the successful main-CI SHA; calculation has no production keys.
[ADR 0016](0016-p6-foundation.md) approves milestone updates; daily behavior changes
with implementation.

Pin revision closure, rational weights, two placements, trials/master seed, scoring
version and initial/retry budgets. Reject unknown fields, duplicate IDs, unsupported
rules and invalid hashes before execution. Limit 64,000 slots; <=1,000 per batch plan.

Normalize ordering/weights. inputHash binds definition and engine/digest; leagueHash
also binds source SHA. Skip unchanged completed inputs. Published revisions are immutable.

league-trial-v1 takes SHA-256's first 32 bits over canonical {version, masterSeed,
trial, purpose:battle}; trial is zero-based. No pair/scenario/league/order/time seed.
ID order assigns streams 0/1; actor-stream-v1 stays attached when swapping slots/starts.
Slot hash binds character revisions, scenario, starts, placement/trial; no league ID.
Adding participants preserves unrelated manifests.

league-score-v1 uses reduced BigInt fractions, bounded decimal strings in JSON.
Keep every planned slot in denominators. Unresolved slots score 0/1 for lower/upper.
All slots must be win/draw for formal ranks; exact ties share rank. Provisional rows
have no rank, sorting by lower score then ID. Rates separately use planned slots.
Two attempts per slot; duplicate delivery is idempotent, conflicting definitive
results fail, retries never add a slot or score twice.

Capacity limits stay pending measured review; execution/publication/UI follow in #134.
