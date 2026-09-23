# ADR 0002: 3D計算基盤と互換性の撤回

Adopted: #1 3D-01–08, TS + Rapier3D WASM0.20.0. Each match owns/frees its world.
Binary64 capsule/ball relative sweeps plus static f32 queries retain bent slides/
simultaneous contacts. Initial basic/tick/API201 replacement never authorized DB
deletion/conversion; later versions: [ADR0010](0010-battle-version-compatibility.md).

[Original design/numerics/prototype evidence](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0002-spatial-engine.md).
Current numerics/collisions: [spatial rules](../rules/spatial-v1.md). Thresholds/
decisions unchanged. [ADR0012](0012-stages-and-reactions.md) adds stages/reactions.
Hash equality≠transformed fairness; checkpoints cannot resume battles.

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

[Prototype JSON](../measurements/3d-01-linux.json): geometry-only pass;
[ADR0011](0011-integrated-performance.md): integrated/storage acceptance. Truncation/
extrapolation cannot prove batch success. Profile before Rust; retain precision/
logging/thresholds. Measurement clocks never enter battle hashes.
