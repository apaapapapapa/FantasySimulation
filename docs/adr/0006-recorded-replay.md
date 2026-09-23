# 保存記録だけから復元する3Dリプレイ

Adopted for #10 R1/R2,#1 P3. Domain display imports no Node/engine/Rapier/Three.js;
playback never loads historical engines or infers unknown motion. Preserve revisions/
identity under [ADR0010](0010-battle-version-compatibility.md).
[Full original recording, durability, retention and delivery contract](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0006-recorded-replay.md)
remains authoritative for this profile. [ADR0012](0012-stages-and-reactions.md)
proposes additions. This summary changes no format/limits/guarantees.

Records use the20ms clock/Y-up binary64/bent traces and replacement deltas.
Causal IDs differ from display sequence; invalid records are rejected atomically.
ReplayState checkpoints cannot resume simulation. Seek is not full-prefix validation;
checksums alone do not prove authenticity. Viewer never recomputes battle outcomes.

Profile display-ndjson-gzip-v1: independent gzip NDJSON,target128KiB,≤250step/chunk,
preceding checkpoint,no split records. Record/checkpoint≈4MB,expanded256,032,768bytes,
compressed≤16MiB. Index/checksums bind ranges/sizes; event hashes remain separate.
[ADR0011](0011-integrated-performance.md) owns acceptance; no silent thinning.
Writer uses awaited backpressure/full verification/file+directory sync/rename before
DB reference. Retain the original POSIX failure and Windows limited-durability rules.
Readers enforce byte/checksum/expansion/UTF-8/count/path limits. Serve compressed bytes
without Content-Encoding, decompress once; no arbitrary URLs/traversal/symlinks.

Bind result/attempt/input/log identities; failures retain last valid extent, never
fabricate results. Corruption blocks cache; never silently regenerate. Retain records
until explicit deletion, reject overcapacity work, back up stopped DB+artifacts.
Recovery removes only unreferenced temporary/orphan files. Domain fixed mutual-hit
and API integration fixtures verify hashes/seeks/terrain/flight/bullets/statuses;
extensions require domain restoration and Worker/SQLite round trips. UI remains P4.
