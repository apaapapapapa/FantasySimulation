# 保存記録だけから復元する3Dリプレイ

Adopted #10 R1/R2,#1 P3. Domain display has no Node/engine/Rapier/Three.js,
historical engine or inferred motion. Revisions/identity:
[ADR0010](0010-battle-version-compatibility.md).
[Original recording/durability/retention/delivery contract](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0006-recorded-replay.md)
is authoritative; formats/limits/guarantees unchanged.
[ADR0012](0012-stages-and-reactions.md) adds stages/reactions.

Records:20ms,Y-up,binary64,bent traces,replacement deltas. Causal IDs≠display sequence;
reject invalid records atomically. Feature validators own action/stage/force/reaction/projectile/event
checks; domain combat derivations supply shared clocks and capped force sums. Saved acceptance
boundaries and tolerances stay unchanged. Checkpoints cannot resume. Seek≠full-prefix
validation; checksums≠authenticity. Viewer never recomputes outcomes.

Profile display-ndjson-gzip-v1: independent gzip NDJSON,target128KiB,≤250step/chunk,
preceding checkpoint,no split records. Record/checkpoint≈4MB,expanded256,032,768bytes,
compressed≤16MiB. Index/checksums bind ranges/sizes; event hashes remain separate.
[ADR0011](0011-integrated-performance.md) owns acceptance; no silent thinning.
Writer uses awaited backpressure/full verification/file+directory sync/rename before
DB reference. Retain the original POSIX failure and Windows limited-durability rules.
Readers enforce byte/checksum/expansion/UTF-8/count/path limits. Serve compressed bytes
without Content-Encoding, decompress once; no arbitrary URLs/traversal/symlinks.

Bind result/attempt/input/log IDs; failure retains last valid extent, no invented
results. Corruption blocks cache/regeneration. Explicit deletion only; reject
overcapacity; back up stopped DB+artifacts. Recovery deletes only unreferenced
temp/orphans. Domain mutual-hit/API fixtures cover hashes/seeks/terrain/flight/
bullets/statuses. Extensions need domain restoration, Worker/SQLite round trips.
API/static viewers share domain seek; Web Workers validate/decode.
Bounds: 2 concurrent loads, 8 decoded files, 2 validated chunks; no full-prefix prefetch.
Clock/camera never advance combat; discard stale replies. Geometry/event/AI overlays use
records; missing launch coordinates and adjusted vision are not guessed.
[Browser evidence, licenses and bundle sizes](../measurements/replay-viewer.json).

D-2 (#106): writes/imports/publication and unknown/legacy profiles require full validation.
Only successful full validation issues a checksum-bound receipt. Trusted coordinator DB reuse/open verifies the manifest,
every compressed size/SHA-256 and attempt/byte/result bindings without inflate/apply.
Nullable additive `validation_profile` preserves old files/results/columns; unknown profiles validate
before adoption. New semantic acceptance needs a new profile. Imported metadata is not an attestation.
API measurements/repeat: `apps/api/fixtures/revalidation-baseline.json`
and `apps/api/tooling/revalidation-benchmark.ts` (not production throughput guarantees).
