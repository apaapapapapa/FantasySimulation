# ADR 0008: Batch and publication

The [execution contract](https://github.com/apaapapapapa/FantasySimulation/blob/e9325df8ca62beba39b85d100265379e4c5ad2fb/docs/adr/0008-headless-batch.md)
owns plans/shards/capacity/deadlines/durability/recovery. `batch check` verifies all inputs:
0 complete, 2 incomplete (missing indexes pending), 1 invalid. Hashes are not authentication.
Historical data is read-only; execution reconstructs current engine/source/digest.

## Publication v1

Domain spatial/publication.ts owns strict v1 schemas (unknown fields/versions fail), no I/O.
Web owns ReplaySource/OpenedReplay. Keys use SHA-256:

```text
catalog/current.json                 mutable catalogHash/decoded-byte pointer
catalog/<hash>.json                   previous hash (initial null), <=1,000 sorted sets
sets/<setHash>/set.json               source, conditions, counts, page references
sets/<setHash>/<pageHash>.json        <=10 pages/set, <=100 slotId-sorted rows/page
objects/<objectHash>/...              original receipt/manifest/chunk/checkpoint bytes
leagues/<hash>.json                   league documents and durable journals
```

Canonical UTF-8 JSON has no newline/self-hash; pages omit setHash. Checksums bind decoded JSON
or compressed gzip. objectHash binds receipt body excluding itself; PublicReplayRef binds receipt
bytes/hash/manifestChecksum. Validate references/preserve fields. Complete = full playback;
unresolved/truncated = verified partial. Failed/pending = null result/reference, zero records,
no playback. Preserve IDs/pending rows; fixed reasons exclude raw errors/cancellation/reaction data.

## Export and transport

Saved-batch export reuses batch check without SQLite/engine/Git/network, binding
plan/index/receipt/revisions/manifest/rows. Allowlist fields; scan JSON/expanded gzip for
absolute paths/private fields/known credentials. Arbitrary secrets remain the administrator's
responsibility. Exclude .work/DBs/environment/drafts/arbitrary files, symlinks/non-layout keys;
separate I/O directories. Preflight all collisions/capacity. Reuse identical bytes;
conflicting bytes/definitive resultHash for one simulation fail. Retain every generation/link.
Hard limits: 8,000,000,000 bytes including pointer staging; 500,000 files (revision below).

Commit objects -> pages -> sets -> leagues -> catalog -> current. Local lock plus pointer
recheck protects replacement; remove abandoned locks only after process exit. Multi-object
writes are not atomic. Export exit 2 preserves slots, not remote acceptance. Pinned AWS SDK
signs conditional PUT. Defaults: <=3 attempts/five minutes; explicit league transport allows
<=2M logical requests, <=900k Class A/2M Class B, one hour, one SDK attempt. Counters charge
before admission, including failures. Validate retained graph/bundles/privacy, inventory,
collisions, source ancestry/viewer formats and budgets before writes. HEAD every reference,
recheck generation/viewer, then replace current with If-Match (first publish If-None-Match).
S3 and reader catalog/set/sample-bundle readback must pass. Lost responses remain uncertain:
retry identical input. Explicit prune protects ancestors/stops on pointer change; no automatic
upgrade/deletion. Opt-in concurrency 1..16 defaults to 1; stage barriers wait for all admitted
operations on error. Cached bundles still validate every reference.

## Cloud operation

User-approved [smartphone operation](../development/cloud-publication.md), no owner PC.
The existing [workflow](../../.github/workflows/publication.yml) stays manual/serialized,
exact successful main CI/ci-gate SHA rechecked after Environment protection. Calculation/export
is secret-free; pass plan/index/objects by same-run artifact ID. R2 keys belong only to the
publication step in main-restricted Environment r2-publication, never repository-wide secrets,
agents/chat/logs/source/Pages. Worker deployment has separate cloud authorization.

Restore into a new directory using shared graph/bundle/expanded-privacy checks. Reserve in-flight
bytes before reads; recheck present/absent pointer; failure removes only the owned directory.
Default/manual restore/upload: 256MB; opt-in <=8GB. Conditional PUT guards other processes.
--require-complete-input rejects current partial input before S3 access; historical partial rows
stay visible without exit 2. Otherwise CLI partial-row semantics remain.

## Reader and acceptance

Private R2; PublicKeySchema permits only GET/HEAD/OPTIONS, no list/write/signing/engine.
JSON application/json; gzip application/gzip without Content-Encoding. no-transform;
current max-age=30, immutable max-age=31536000, CORS exact Pages origin. Viewer distinguishes
missing/damaged/unsupported/unavailable/visible 429 or 1027; CORS-hidden failures stay unavailable.

2026-09-25 [R2](https://developers.cloudflare.com/r2/pricing/): Standard includes 10GB-month,
1M Class A/10M Class B monthly/free egress; [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
Free 100k/day account-wide. Monitor plans/usage/alerts; stop on budget/quota errors. Acceptance:
actual costs, bytes/requests, URL/build, browsers/recovery/repeat publication. Mocks do not suffice;
project counters cannot cap unrelated account traffic.

[Pinned production acceptance](https://github.com/apaapapapapa/FantasySimulation/blob/feb61f3e46e51dc79aeb613f9bc26ec99212f29b/docs/adr/0008-headless-batch.md)
retains deployed URLs, recovery/mobile checks, owner-approved token scope, actual paid plans,
invoices and alerts (not caps). Two matches: 34 files/170,759 bytes; repeat transfer 0.

## League publication v1 (Refs #134)

Optional catalog.leagues (latest snapshot per ID)/leagueWork preserve old catalog bytes.
Documents: revision/summary/character detail/<=100-slot pair pages/progress/journals.
Overview loads details/slots on demand. A slot binds
leagueHash/slot ID to setHash/pageHash/rowId and immutable replay. Empty sets require a journal.
Graph/checksum/exact-score validation executes no battle/DB. `league export` validates current
plans and commits all partitions once; saved-batch export stays execution-free.
Keep partial receipts; reject conflicting definitive win/draw results. Reused receipts may
predate new set source: simulation/engine/digest must match and both sources belong to viewer
ancestry. Restore/readback cover retained leagues. `publication upload` accepts a verified
provisional graph with exit 0 and explicit unresolved counts/rank status.

Journal before admission; finish only that execution. Retain histories across days/killed workers.
Two attempts maximum; reservations consume attempts. Refund only verified never-admitted work.
Reject missing history, changed reservations and rollback. Actions/official acceptance: #134.

## Measured capacity revision (2026-09-25)

[Local pilot](../measurements/p5-league-pilot-linux.json): 4 characters/5 fields/2 placements/1 trial,
60 wins, sequential 32/28 partitions/2 Workers: 63,382ms, public 926 files/6,678,394 bytes;
per-object max 40 files/312,213 bytes. Observed means imply ~115k files/818MB for 7,600,
exceeding 100k/256MB. This is not a worst-case bound or Actions/production acceptance.

Reviewed file cap: 500k including history; keep 8GB storage, <=1,000 slots/plan, <=512MiB work.
Estimate: 128 slots/plan, 4s/600kB/44 files per computation, 24MB metadata/partition;
60 partitions project 6GB/335,183 files plus measured retention. Add persistent request usage;
reject excess before admission. Actual limits stop underestimates; never expand automatically.
League workflow opts into its budget. Monthly reservations/official acceptance remain in #134.
