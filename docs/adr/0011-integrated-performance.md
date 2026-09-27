# ADR 0011: Integrated performance

TS/Rapier/Piscina (#60): default one/maximum four Workers; 1.5GiB abort.
1,000-match history, not P4/P5 acceptance:
[measurements](../measurements/p3-integrated-linux.json),
[protocol](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0011-integrated-performance.md).

## Refinements — #189/#210

Preserve [recording](0006-recorded-replay.md), [publication](0008-headless-batch.md),
bindings, denominators, attempts, quotas, retention and review/measurement.
Cache 256 successes; authenticate receipt/manifest/compressed bytes, not mtime/claims.
Eviction/closure revalidates. Share aggregation; independently validate
post-callback export (four to two).
Index verified results.
Bound original-JSON decoding; retain UTF-8/checkpoints/hashes.
Verifiers: inline default, cloud two, cap four/CPUs minus one; bounded heaps/batches.
Empty environments are not sandboxes. Propagate aborts; drain/close. Worker spans
are neither CPU nor additive wall time. Keep four durable immutable writes,
fsync/link/directory sync and pointer-last commit.

Share fresh post-validation inventory in one serialized publication.
Receipt GET or verified local bytes/size/MD5 ETag prove bytes; orphans still GET.
Keep lease-size accounting, conditional PUT, generation/viewer/readback barriers.
Reserve collision OR recovery GET per file, pointer checks and retry headroom,
not removed HEADs. No pointer caching or lease refunds.
Prefetch validated children to owned disk without discarded rereads; deduplicate,
bound payloads/requests and drain before cleanup. Local graph I/O uses four,
separate from verifiers; sort references. Share only in-flight directory checks
per path/mode; measure mkdir/lstat.
Transfer fair-fit scans 64 entries, caps overtakes at eight/task, then drains.
Cloud GET/HEAD:32; PUT/Reader:16. Tuning:1–64,16–256MiB (default64MiB), not RSS.
Match sockets/keep-alive; measure LIST. Retain serial control writes, bucket
settings, Local Uploads, formats and workflows.
