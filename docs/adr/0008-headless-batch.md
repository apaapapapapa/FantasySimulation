# ADR 0008: Batch and publication

The [execution contract](https://github.com/apaapapapapa/FantasySimulation/blob/e9325df8ca62beba39b85d100265379e4c5ad2fb/docs/adr/0008-headless-batch.md)
governs plans, capacity, shards, deadlines, durability, ownership and recovery.
`batch check` verifies all slots/source/shards/receipts/files: exits 0 complete, 2 incomplete,
1 invalid; absent indexes mean pending. Hashes are not authentication. Historical data is
readable, never executable; execution requires current engine/source/digest and reconstruction.

## Publication v1

`packages/domain/src/spatial/publication.ts` owns strict schemaVersion=1 Zod/types without I/O;
unknown fields/versions fail. Web owns ReplaySource/OpenedReplay. Keys use 64-digit SHA-256:

```text
catalog/current.json                 mutable catalogHash/decoded-byte pointer
catalog/<hash>.json                   previous hash (initial null), sorted <=1,000 sets
sets/<setHash>/set.json               source, conditions, counts, page references
sets/<setHash>/<pageHash>.json        <=10 pages/set, <=100 slotId-sorted rows/page
objects/<objectHash>/...              original receipt/manifest/chunk/checkpoint bytes
```

New JSON: canonical UTF-8, no newline/self-hash; pages omit setHash. JSON checksums bind decoded
HTTP bytes; gzip binds compressed bytes. objectHash binds canonical receipt body excluding
objectHash; PublicReplayRef binds receipt bytes/hash and manifestChecksum. Validate graph references and
preserve all schema fields. Complete is full playback;
unresolved/truncated is verified partial playback; failed/pending have null result/reference,
zero records and no playback. Never invent IDs/drop pending rows. Reasons are fixed codes;
raw errors/cancelled diagnostics/reaction internals stay outside listings.

## Export and transport

Export reuses batch check without SQLite/engine/Git/network, binding plan/index/receipt,
revisions, manifest inputs and rows. Allowlist public fields; scan JSON/expanded gzip for
absolute paths/private fields/known credentials. Arbitrary secrets remain the administrator's
responsibility. Exclude .work/DBs/environment/drafts/arbitrary files, symlinks and non-layout keys. Separate I/O
directories. Preflight collisions/capacity, then object -> page
-> set -> catalog -> current. Reuse identical bytes; conflicting bytes/resultHash for one
simulation fail. Retain all generations/links.
Cap storage at 8,000,000,000 bytes including pointer staging, and 100,000 files.

Multi-object writes are not atomic. Local lock plus pointer recheck protects replacement;
remove abandoned locks only after the process stops. Export exit 2 preserves slots, not remote
acceptance. S3 uses pinned official AWS signing, conditional
PUT, <=3 attempts and five-minute deadline. Validate retained graphs/bundles/privacy, inventory,
collisions, source ancestry/viewer formats and budgets before writes. HEAD every reference,
recheck generation/viewer, replace current with If-Match (first publish If-None-Match).
S3 and reader catalog/set/sample-bundle read-back must pass before verified success. Lost
responses remain uncertain: rerun identical inputs. Explicit prune protects all ancestors and
stops on pointer change. No automatic deletion or upgrade.

## Cloud operation (2026-09-24)

User-approved: [smartphone-only setup](../development/cloud-publication.md), no owner PC.
The [workflow](../../.github/workflows/publication.yml) is manual/serialized, exact successful main
CI/ci-gate SHA rechecked after Environment protection. Calculation/export is secret-free; pass plan/index/objects
by same-run artifact ID. Bucket-only keys belong to main-restricted Environment r2-publication,
only its publication step, never repository-wide secrets, agents, chat, logs, source or Pages.

Restore all retained generations into a new directory before export using shared graph/bundle/
expanded-privacy checks and bounded reads. Recheck present/absent pointer; failure removes only
its new directory. Restore defaults to 256MB, caps at 8GB; Actions keeps 256MB. Conditional PUT
remains the cross-process guard. --require-complete-input rejects current partial input before
S3 access; historical partial counts remain visible without changing verified success to exit 2.
Without the flag, CLI partial-row semantics remain unchanged. Worker deployment uses separate
cloud authorization; no owner-PC requirement.

## Reader and acceptance

Private R2; PublicKeySchema GET/HEAD/OPTIONS only, no list/write/signing/engine. JSON uses
application/json; gzip uses application/gzip without Content-Encoding. no-transform;
current max-age=30; immutable max-age=31536000; CORS exact Pages origin. Viewer distinguishes
missing/damaged/unsupported/unavailable/visible 429 or 1027; CORS-hidden failures stay unavailable.

2026-09-23 baseline: [R2](https://developers.cloudflare.com/r2/pricing/) Standard includes 10GB-month,
1M Class A/10M Class B monthly, free egress; [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)
100k/day account-wide. No zero-charge guarantee: inspect whole-account usage/plans/alerts;
stop on budget/quota errors. Record actual plan, retained bytes, upload/Worker requests, costs,
URL/build SHA, browser replay/CORS/compression and interruption/republication evidence.
Mocks or workflow implementation alone never establish production acceptance.
