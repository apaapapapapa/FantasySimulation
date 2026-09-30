# Simulation evidence

[Authoritative full protocol](https://github.com/apaapapapapa/FantasySimulation/blob/c99b04394ad6bc091c100ed8f73fac6ca57d3075/docs/development/simulation-evidence.md)
retains all gates/bounds/commands/receipts/reproduction/history unchanged.
[Delivery](../../.github/harness/README.md) remains required.

## Fixed corpus

verify runs check:corpus after tests. corpus.json pins definitions/engine/rules/PRNG/
physics/inputs/mappings except implementationDigest. Check identities, all mapped receipts
and two result/event/trajectory/TS/physics repeats. Missing/skipped/stale is unknown;
failures fail; optional categories are uncovered. Keep raw results/commands/source/toolchain;
never regenerate expectations. Mapping/input edits need rationale/review. Preserve
Registry512/category64/entry64, other bounds and boundary/overflow negatives.

## Linux, Worker and property evidence

Writer decode moved from local `stages` to bounded `verificationWorkerStages` when
parent measurement is enabled: counts/bytes/failures/incomplete/inclusiveMs.
`busyWallSumMs` sums task-local time, not cross-Worker union; never add Worker time/CPU
to process wall union/CPU. Compare old/new locations; seal/publication counts/IDs stay.

Linux-only CI pins source/toolchain/plan/run/attempt. Real Piscina1..4 reversed submissions
need>=2 usable Workers; disposable SQLite has independent ownership expectations.
Keep restart/durability/failure/cancellation evidence. Test-only fast-check4.10.2 pins
seed20260923,<=24 runs/operations,30s including shrinking. Keep interruption/minimal-input/
seed/path/command receipts; discards fail. FANTASY_PROPERTY_ID/SEED/PATH reproduces one case.
Game randomness stays fixed. Fairness maps exchanged identity/pose/streams/outcomes,
not different-input hashes; timing proves neither fairness nor performance.

## Deterministic budgets and paired load

check:load uses all fixed inputs,1 warmup+5 measurements. SHA evidence requires clean
current/paired collection. Keep deterministic ceilings, strict zero budgets and6000/250-step
bounds; fixtures are not capacity claims. vp run harness load <FULL_BASELINE_SHA> owns
disposable frozen baseline,5 alternating pairs/case,target pins/raw receipts. Candidate
dependencies, invented before values and setup failures are not comparable evidence.

Three Linux shards keep each case's pairs on one runner; pin base/run/attempt and retain
raw samples/budgets/regression probe before aggregation. Separate CPU/elapsed/RSS/Worker/
unavailable metrics. [CI plan](ci.md) owns PR exclusions. Input/profile/runtime/cost changes
need exact-base reviewed load-reviews.json; independent transitions can leave pairing
unknown. Review grants no approval/waiver. Same-profile changes need pairing; distinguish
original regression probe/source-driver. Full protocol owns exceptions/reproduction.

## Integrated persistence performance

[ADR0011](../adr/0011-integrated-performance.md):1000-battle fixed-machine protocol.
[ADR0019](../adr/0019-league-pipeline.md):approved7600-match pipeline/measured baseline;
existing verification gates stay.
