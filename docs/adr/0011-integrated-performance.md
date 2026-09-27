# ADR 0011: Integrated performance

PR #60 selected TS/Rapier/Piscina: default one/maximum four Workers, 1.5GiB abort.
Historical 1,000-match measurements and reproduction (not P4/P5 acceptance):
[Evidence](../measurements/p3-integrated-linux.json) and the
[original protocol](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0011-integrated-performance.md)

## Requested refinements — #189/#210

Preserve [recording](0006-recorded-replay.md), [publication](0008-headless-batch.md),
bindings, denominators, attempts, quotas and retention. Review and real performance
evidence remain required.

Sessions keep 256 successful hashes. Reuse authenticates receipt, manifest and
compressed bytes, never mtime/claims. Eviction/closure requires full validation.
Share three aggregation passes; independently validate export after its callback
(four to two). Index authenticated results.

Inspect original JSON during bounded decoding; retain UTF-8, checkpoints and hashes. Verifiers default inline; cloud requests two, capped at four/CPUs minus
one. Bound heaps/batches; empty environments are not sandboxes. Propagate aborts
inline too; drain and close. Worker spans are not CPU or additive wall time.
Keep four durable immutable writes, fsync/link/directory sync and pointer-last commit.

Share fresh post-validation inventory within one serialized publication.
Account for lease size; retain orphan conflicts,
all-reference HEAD, conditional PUT, generation/viewer/readback barriers. Reuse exact
receipt GET evidence, not buffers. No pointer caching or lease refunds.

Prefetch hash/size-bound children after parent validation into owned disk.
Deduplicate keys; retain ordered checks and bounded requests/payloads;
drain before cleanup. Cloud GET/HEAD use 32; PUT/Reader use 16. S3 tuning allows 1–64
and 16–256MiB payload reservations (64MiB default), not RSS guarantees. Match sockets
and keep-alive. Measure LIST pages. Keep serial control writes, retries, bucket
settings, Local Uploads, formats and workflows unchanged.
