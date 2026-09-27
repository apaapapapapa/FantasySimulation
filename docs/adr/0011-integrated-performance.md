# ADR 0011: Integrated performance

PR #60 accepted TS/Rapier/Piscina: 1,000 new matches, two Workers, 1504.65s,
ten [gates](0002-spatial-engine.md) passed.
P95 was 7.721s (8s limit); the last quarter was 9.056s. This is not P4/P5 acceptance.
Keep default one/maximum four Workers and the 1.5GiB abort threshold, not an OS cap.
[Evidence](../measurements/p3-integrated-linux.json) and
[original protocol](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0011-integrated-performance.md)
retain the protocol and evidence. CI is not reference-host acceptance.

## Publication refinement — #189 / #210, 2026-09-27

The owner requested these changes after design review; independent review, latest CI
and same-input performance evidence remain required. [Recording](0006-recorded-replay.md)
and [publication](0008-headless-batch.md) contracts stay unchanged.

Fresh per-partition sessions retain only 256 successful object hashes. Every reuse
rereads/authenticates receipt, manifest and all compressed bytes; names/mtime/external
claims grant no trust. Eviction, closure and new sessions require full verification.
Share aggregation's three semantic passes; keep a fresh export pass after the journal
callback (four to two). Keep every binding, denominator, consumed attempt and conflict.
Index authenticated results instead of stringifying them.

Inspect original JSON during the existing bounded decode/semantic pass. Keep UTF-8,
checksums, limits, checkpoints and terminal hashes. Piscina verifiers default inline;
cloud requests two, capped at four and available CPUs minus one. Use bounded batches,
empty environments and explicit loaders, not an OS sandbox. Drain failures/cancellation
and close pools; Worker spans are not CPU or additive wall time.

After preflight, allow four immutable writes with unchanged fsync/link/directory sync.
Drain before failing; recheck generation and commit current.json last. Never parallelize
mutable pointers/leases. No format, rules, retention, quota, R2 concurrency or main change.
