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

## Publication refinement — Issue #189 / PR #210

2026-09-27: the owner requested the three publication changes in the same PR after
reviewing the proposed boundaries. This records the design before implementation;
independent review, latest-head CI and measured performance acceptance remain required.
It extends the execution strategy, not the recording format or the trust contracts in
[ADR 0006](0006-recorded-replay.md) and [ADR 0008](0008-headless-batch.md).

### Verification scope

Each received partition gets a fresh, bounded, process-local verification session.
Only successful execution of the existing full replay validator admits a bundle.
Every subsequent access still authenticates receipt and manifest and reads/hashes
all referenced compressed files. Names, mtimes, external receipts and a supplied
`verified` flag never establish trust. The session retains at most 256 object hashes,
not expanded records, and is explicitly closed at the end of its owner operation.
Eviction or a new session means full validation again; failed work is never cached.

The three aggregation bindings share one full pass. Publication export opens a new
session after the journal callback, preserving independent validation and rejection
of callback-time corruption. The target for a new definitive trial is two full
passes instead of four, not fewer logical binding checks. Keep all missing slots,
consumed attempts, result conflicts and old recording reads. An authenticated result
ID maps directly to its original input; do not stringify every result to locate it.

### Decode once and run independent trials concurrently

Move the existing public-text inspection into the API recording layer and re-export
it for publication callers. Inspect the original parsed checkpoint/record before
schema normalization, during the full replay pass. Keep strict UTF-8, decompression
bounds, checksum/byte checks, checkpoint continuity and terminal/hash validation.
No alternate validator, engine execution or weaker schema is introduced.

Use the existing Piscina runtime for a dedicated replay-verification entry point.
Library calls default to one in-process verifier; cloud finalization/publication
request two Workers, capped by available CPUs with one reserved and an absolute
maximum of four. Tasks are admitted in bounded batches, without an unbounded queue.
Workers receive only directory/manifest/inspection inputs, an empty environment and
explicit loader arguments; they do not inherit R2 secrets. Worker threads are not
an OS security sandbox. Errors stop new admission, admitted work is drained, and
pools/sessions are closed in finally blocks. Cancellation must not commit a pointer.
Preserve per-replay validation counts and distinguish Worker wall spans from CPU;
internal Worker decode/hash time must not be misreported as zero or summed into wall.

### Durable parallel writes

After existing collision/privacy/capacity preflight, publish different immutable
files with at most four in-flight operations. Reuse the existing bounded publication
pool and retain every file fsync, atomic create-only link and directory sync. Stop
admission on failure and await all admitted operations. Recheck generation and replace
`catalog/current.json` only after every immutable write succeeds. Do not parallelize
mutable pointer or usage-ledger updates; incomplete immutable orphans remain invisible.

No pack format, R2 concurrency/quota, retention, paid runner, schema/rules change,
workflow restart or main merge is part of this refinement. Compare identical inputs,
outputs, CPU/wall distributions, RSS and fault behavior before claiming improvement.
