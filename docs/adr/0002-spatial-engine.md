# ADR 0002: 3D計算基盤と互換性の撤回

Adopted for #1 3D-01–08. Keep TS + Rapier3D WASM0.20.0. Shared interval queries
preserve bent slides/simultaneous contacts; binary64 analytic capsule/ball relative
sweeps complement static f32 queries. Each match owns/frees its world. Initial
basic/tick/API201 replacement did not authorize deleting/converting databases.
Later versions follow [ADR0010](0010-battle-version-compatibility.md).

[Full original rationale, numerical decisions and prototype evidence](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0002-spatial-engine.md)
remain fixed historical evidence. Current numerical/collision rules are in
[spatial rules](../rules/spatial-v1.md); [ADR0012](0012-stages-and-reactions.md)
proposes stages/reactions. This consolidation changes no thresholds or decisions.
Current CI: Linux. Original cross-OS evidence remains linked; hash equality differs
from transformed fairness; checkpoints cannot resume battles.

## 基準機と変更しない目標

EPYC9V74,8 CPUs,about21.5GiB,Linux x64,Node24.19.0,overlay; disk/IOPS unknown.
Shared CI timing is not performance acceptance. Initial1,000-match capacity:
≤6000step/256 obstacles/64 live projectiles per match.

- Prototype warm median≤2s/p95≤4s; integrated including storage≤4s/8s.
- Fresh1,000 matches,≤4 Workers,≤30min,≥0.56/s. Compare1/4 Workers,
  reserve≥1 CPU for API/storage; default1,max4.
- Worker heap≤128MiB,whole-process RSS≤1.5GiB; second-half growth≤64MiB
  after warmup, separate heap/WASM/external measurements.
- Compressed≤16MiB/match,≤16GiB/1,000; queue128,retained16GiB,
  30s real timeout=attempt failure.

[Prototype JSON](../measurements/3d-01-linux.json) records passing geometry-only
measurements; [ADR0011](0011-integrated-performance.md) owns full storage acceptance.
Neither truncated runs nor extrapolation prove batch success. Profile before Rust
comparison, preserve precision/logging/thresholds; measurement clocks never enter
battle hashes. Detailed historical methods/limitations remain at the immutable link.
