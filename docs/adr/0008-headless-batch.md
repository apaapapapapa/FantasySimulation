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

Saved-batch export reuses batch check without SQLite/engine/Git/network, binding plan/index/receipt,
revisions, manifest inputs and rows. Allowlist public fields; scan JSON/expanded gzip for
absolute paths/private fields/known credentials. Arbitrary secrets remain the administrator's
responsibility. Exclude .work/DBs/environment/drafts/arbitrary files, symlinks and non-layout keys. Separate I/O
directories. Preflight collisions/capacity, then object -> page
-> set -> catalog -> current. Reuse identical bytes; conflicting bytes/definitive resultHash
for one simulation fail. Retain all generations/links.
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
by same-run artifact ID. R2 keys belong to main-restricted Environment r2-publication,
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

2026-09-25 baseline: [R2](https://developers.cloudflare.com/r2/pricing/) Standard includes 10GB-month,
1M Class A/10M Class B monthly, free egress; [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)
100k/day account-wide. Monitor account usage/plans/alerts; stop on budget/quota errors.
Acceptance needs actual plan/costs, storage/write/request counts, URL/build, browser checks
and recovery/republication evidence. Mocks alone do not establish production acceptance.

### Production acceptance (2026-09-25)

[Pinned acceptance](https://github.com/apaapapapapa/FantasySimulation/blob/feb61f3e46e51dc79aeb613f9bc26ec99212f29b/docs/adr/0008-headless-batch.md)
retains deployment, republish/rollback, Chromium/WebKit 390x844 playback/manual-step,
account screenshots and owner authorization for the existing account-wide R2 token.
Two complete matches: 34 files/170,759 bytes; repeat transfer zero; cold playback 12/28
reads (not bills). R2 Standard/private, no expiry, two $10 alerts (not caps).
Workers Paid ending 2026-10-12, R2 Paid active; no Free migration. Paid invoices
$5.50/$1.07 lack project attribution; metered usage $0 excludes fixed fees.

## League publication v1 (Refs #134)

Optional catalog.leagues (latest snapshot per ID) and leagueWork retain old catalog bytes.
leagues/<hash>.json stores revision, summary, per-character detail, <=100-slot pair pages,
progress pages and admission journals. Overview omits opponent details/slot lists; load
on demand. A slot links leagueHash/slot ID to setHash/pageHash/rowId and its immutable replay.
Empty sets are allowed only with a journal. Every graph reference/checksum and exact score
is checked before upload; saved schedule/scoring validation executes no battle or database.
`league export` validates current plans; the existing saved-batch export remains execution-free.

Commit objects -> pages -> sets -> league documents -> catalog -> current, once for all
partitions. Keep partial receipts; only conflicting definitive win/draw results fail.
Reused receipts may predate the new set source; pin equal simulation/engine/digest and require
both sources in viewer ancestry. Restore and readback traverse retained league generations.
`publication upload` publishes an already exported graph: verified provisional data exits 0;
its unresolved counts and rank status remain explicit.

Journal before admission; finish only its reserved execution. Carry all simulation histories,
including absent/killed workers, across days. Two attempts maximum; reserved counts as consumed.
Refund only verified never-admitted work. Reject missing history, changed reservations and
catalog journal rollback. Actions integration/official measurements remain in #134.
Existing 1,000-slot plans, 100,000 files, 8GB storage and 256MB default restore/transfer remain.
