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

[Publish run 36057392026](https://github.com/apaapapapapa/FantasySimulation/actions/runs/36057392026)
source `4618f3c`: attempt 1 verified 34 writes/170,759 bytes/26 reader requests;
attempt 2 restored 34 files, reused 33 immutable files, wrote/transferred zero.
Graph: two complete matches, 34 files/170,759 bytes; no deletion.
S3 logical requests: restore+publish 2+73 initially, 35+75 on repeat (not billing counters).

[Rollback/restore run 36113472940](https://github.com/apaapapapapa/FantasySimulation/actions/runs/36113472940)
deployed `4618f3c`, restored `d0b32d0` through the successful-main-CI gate.
Both: unchanged graph/links, Chromium/WebKit 390x844, 3D/playback/seek/direct-URL reload,
zero API requests/page/HTTP errors. Manual browser playback/reload also passed with 2D fallback.
Separately, remote/restore/reader fixtures passed 88 tests for interrupted/lost-response recovery,
stale generations, collisions and budgets.

[Full playback 36113835189](https://github.com/apaapapapapa/FantasySimulation/actions/runs/36113835189):
both browsers reached steps 121/747; list 4 + playback 8/24 = 12/28 cold reader requests;
direct-URL reload/startup 8. Free 100k/day permits at most 3,571 longer views, excluding
retries/publishing/other traffic: a conditional estimate, not measured billing or audience guarantee.

Cloudflare: Standard/private `fantasysimulation-replays`, no public custom domain/object expiry;
`REPLAYS` binding, workers.dev enabled/previews disabled. Deployment
`0c8ff026-eb60-4978-a319-9bdf3040c7ce`; code SHA-256
`73651b0fb4fb254e3e63f096fd557098f89ecf3f7786c421030b012fe7a16554` (241,609 bytes;
[deployment record](https://github.com/apaapapapapa/FantasySimulation/issues/81#issuecomment-5805398131)).
Account R2 metrics: 253,096,620 payload bytes, 300,630 metadata bytes, 1,612 objects; IA zero.
Two existing $10 billing alerts are enabled. They are notifications, not a spending cap.

[Owner evidence](https://github.com/apaapapapapa/FantasySimulation/issues/81#issuecomment-5833944717)
closes the API-access gap (billing 10000, token metadata 9109): Workers Paid is ending
(date column 2026-10-12), R2 Paid active. Free migration is not claimed. Billable Usage
observed Sep 12–25 of the Sep 12–Oct 11 cycle (14/30 days): total, projected and daily-average
usage costs $0.00; all usage within included tiers. This excludes fixed subscriptions,
is not a project-specific invoice and does not guarantee future zero costs.
[Owner decision](https://github.com/apaapapapapa/FantasySimulation/issues/81#issuecomment-5833903078)
accepts the existing account-wide R2 token instead of requiring bucket-only replacement.
No new privileges or credentials were supplied. Environment/step isolation, private storage,
bounds and cost monitoring remain required.
