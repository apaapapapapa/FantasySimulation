# ADR 0008: Batch and publication

[Authoritative current contract](https://github.com/apaapapapapa/FantasySimulation/blob/c99b04394ad6bc091c100ed8f73fac6ca57d3075/docs/adr/0008-headless-batch.md)
retains ALL limits, predicates, command/exit semantics, evidence and linked execution/
protocol history. This navigation summary changes none of them.
[ADR0011](0011-integrated-performance.md) records implemented refinements;
[ADR0019](0019-league-pipeline.md) is approved; its rollout gates still apply.

## Publication v1

Strict schemas and full saved-binding/byte/privacy validation before transport;
saved reads never execute engines. Hashes are not authentication. Retain partial
denominators, conflict rejection, durability, pointer-last conditional commit,
ancestry/readback, precharged budgets, failure drain and owned restore cleanup.
No automatic deletion/upgrade. Full contract owns predicates and CLI semantics.

## Cloud and Reader

[Smartphone operations](../development/cloud-publication.md): successful main CI,
protected credential steps only; keys never reach agents/Pages/compute. Separate Worker
deployment approval. Private R2; narrow read-only allowlist, exact-origin CORS,
JSON/gzip without Content-Encoding, no-transform, current30s/immutable31536000s cache.
Retain quota/error distinctions. Full contract owns default/league-transfer budgets,
retry/deadline rules and dated pricing/production evidence; mocks cannot prove acceptance.

## League publication v1 (Refs #134)

Immutable plans/slots/input/source/attempt/replay bindings, journal-before-admission,
two attempts, no lost history/duplicate scoring. Formal only when all slots resolve;
provisional counts remain. [Milestones](0016-p6-foundation.md) gate official updates.
Keep whole-workflow r2-publication exclusion;64 partitions/4 jobs/2 Workers/25m compute.
Never rerun failed jobs alone. Recovery checks original successful workers, CI/ancestry,
artifacts/catalog equality; no simulation/new reservation/refund. Retain7-day artifacts
and full contract's recovery/publication timeouts.

Private usage ledger is outside Reader/prune. Conditional verified leases, no consumed
lease refunds/reset; missing ledger requires recovery. Monthly900k A/9M B,10k control
reserve; Worker90k/day,1k probe reserve. Preserve default and transient-retry accounting.
[P5 evidence](../measurements/p5-official-actions.json) retains historical acceptance status.

## Capacity (2026-09-25)

Caps8GB/500k including control/history/staging,1000 slots/plan,512MiB work.
[Pilot](../measurements/p5-league-pilot-linux.json) and full contract retain raw measurements/
estimates/reproduction. Extrapolation is not production proof; underestimates fail at bounds.
