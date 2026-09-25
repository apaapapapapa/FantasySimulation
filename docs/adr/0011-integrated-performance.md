# ADR 0011: P3 integrated performance

PR #60 accepted TypeScript + Rapier + Piscina: 1,000 new matches on 2 Workers
completed in 1504.65s and passed all ten gates in [ADR 0002](0002-spatial-engine.md).
Keep thresholds and default 1 / maximum 4 Workers. This is not P4/P5 acceptance.

[Historical receipt](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0011-integrated-performance.md)
and [measurements](../measurements/p3-integrated-linux.json) retain exact source/toolchain,
host, raw-log references, four-Worker comparisons and the reviewed identity transition.

## Reproduction

Run from a clean commit into an unused directory:

```sh
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-full 2 1000
```

The fixed integrated profile uses 13 characters, 10 pairs, seed 20260923 + input
index and 200 full 6,000-step trials through real Worker/SQLite/replay/bundle paths.
For profiling, pass 1 or 4 Workers and 100 trials; `full-batch` then remains unknown.
Shared CI does not replace reference-host performance acceptance.

## Limits

No failures, truncations or cache reuse occurred. Overall p95 was 7.721s (8s limit),
but the final quarter reached 9.056s. Do not extrapolate to other hosts, worst-case
geometry/projectiles or 495,000 matches. RSS is sampled at 100ms, Worker memory per
attempt; memory categories are not additive. Above 1.5 GiB, stop admission and abort
attempts; this is not an OS cap. Preserve world disposal, WASM reuse and pool closure.
Backpressure includes transfer, validation, compression and storage; separate TS/WASM
CPU, HTTP and task queue latency remain unmeasured. External service deployment needs
OS-isolation review.
