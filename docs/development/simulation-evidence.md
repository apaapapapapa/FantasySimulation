# Simulation evidence

[Authoritative full protocol](https://github.com/apaapapapapa/FantasySimulation/blob/c99b04394ad6bc091c100ed8f73fac6ca57d3075/docs/development/simulation-evidence.md)
retains ALL gates, bounds, commands, receipt fields, reproduction and history.
This navigation summary changes none. [Delivery](../../.github/harness/README.md) remains required.

## Fixed corpus

verify runs check:corpus after tests. corpus.json pins definitions/engine/rules/PRNG/
physics/inputs/mappings; only implementationDigest is excluded. Validate identities,
all mapped-test receipts and two actual result/event/trajectory/TS/physics repeats.
Missing/skipped/stale evidence stays unknown; failures fail. Optional planned categories
are not covered. Keep raw results/commands/source/toolchain. Never regenerate candidate
expectations. Mapping/input edits require rationale/review. Registry512/category64/entry64,
other bounds and boundary/overflow negatives remain.

## Linux, Worker and property evidence

Linux-only CI binds actual source/toolchain/plan/run/attempt. Real Piscina1..4 Workers
with reversed submissions requires >=2 usable Workers; disposable SQLite uses independent
ownership expectations. Retain restart/durability/failure/cancellation evidence.
Pinned test-only fast-check4.10.2:seed20260923,<=24 runs/operations,30s including shrinking.
Keep interruption/minimal-input/seed/path/command receipts; discards never pass.
FANTASY_PROPERTY_ID/SEED/PATH reproduces one case, not a suite. Game randomness unchanged.
Fairness maps exchanged identity/pose/streams and outcomes, not different-input hashes.
Timing does not prove fairness/performance.

## Deterministic budgets and paired load

check:load uses every fixed input,1 warmup+5 measurements. Dirty verification is not
SHA evidence; clean current/paired collection is. Preserve deterministic ceilings,
strict zero budgets and6000/250-step bounds. Regression fixtures are not capacity claims.
vp run harness load <FULL_BASELINE_SHA> owns disposable frozen baseline collection,
5 alternating pairs/case, per-target pins and complete raw receipts. Never substitute
candidate dependencies, invented before values or setup failures for comparable evidence.

Three Linux shards keep each case's pairs on one runner, with exact base/run/attempt,
all raw samples/budgets/regression probe before aggregation. Distinguish CPU, elapsed,
RSS, Worker and unavailable metrics. [CI plan](ci.md) owns PR exclusions.
Changed input/profile/runtime/costs require exact-base reviewed load-reviews.json;
independent transitions may leave paired-comparability unknown. Review is not approval
or a waiver. Same-profile changes require pairing; preserve the original regression
probe/source-driver distinction. Full protocol owns all exceptions and reproduction.

## Integrated persistence performance

[ADR0011](../adr/0011-integrated-performance.md):1000-battle fixed-machine protocol.
[ADR0019](../adr/0019-league-pipeline.md):approved7600-match pipeline and measured baseline,
not a change to existing verification gates.
