# ADR 0008: Batch and publication

The [execution contract](https://github.com/apaapapapapa/FantasySimulation/blob/e9325df8ca62beba39b85d100265379e4c5ad2fb/docs/adr/0008-headless-batch.md)
owns plans/shards/capacity/deadlines/durability/recovery. `batch check` verifies all inputs:
0 complete, 2 incomplete (missing indexes pending), 1 invalid. Hashes are not authentication.
Historical data is read-only; execution reconstructs current engine/source/digest.

## Publication v1

The [reviewed protocol](https://github.com/apaapapapapa/FantasySimulation/blob/3b5a1846fe63a450b94998a9fbe8c8839fec18c6/docs/adr/0008-headless-batch.md)
remains authoritative for schemas, binding, privacy, transport and production evidence.
Current contracts:

- Strict domain schemas reject unknown fields/versions. Public layout: catalog/current.json,
  catalog/<hash>.json, sets/<setHash>/{set,<pageHash>}.json, objects/<objectHash>/...,
  leagues/<hash>.json. Catalogs retain all ancestors, <=1,000 sets; sets <=10 pages,
  <=100 sorted slots/page. Canonical UTF-8 JSON has no newline/self-hash; pages omit setHash.
  Hash decoded JSON/compressed gzip; receipts bind original manifests/artifacts/results.
- Saved-batch export uses batch check, never SQLite/engine/Git/network. Complete supports full
  playback; unresolved/truncated verified partial playback; failed/pending has null result/ref,
  zero records/no playback. Preserve IDs/fields/denominators; fixed reasons exclude raw diagnostics.
- Allowlist public fields; scan JSON/expanded gzip for paths/private fields/known credentials.
  Arbitrary secrets remain administrator responsibility. Exclude DBs/.work/environment/drafts,
  symlinks/non-layout keys. Reject conflicting bytes/definitive results; reuse identical bytes.
- Preflight graph/bundles/privacy, inventory, collisions, viewer ancestry/formats and budgets.
  Hard caps: 8,000,000,000 bytes including staging, 500,000 files. Commit objects -> pages ->
  sets -> leagues -> catalog -> current. Local lock and pointer recheck; conditional S3 PUT
  (If-Match, initial If-None-Match). Remove abandoned locks only after process exit.
- Default transport: 100k logical requests, <=3 SDK attempts, five minutes, concurrency 1,
  256MB restore/transfer, 10k writes/200 Worker reads. Explicit --league-transfer on
  publish/upload/restore: 8GB/500k writes/1,000 Worker reads/16 concurrent operations;
  S3 <=2M requests, <=900k Class A/2M Class B, one hour, one SDK attempt. Environment limits
  may lower defaults. Charge requests before admission, including failures. Parallel stage
  barriers await every admitted operation on error; deduplication still checks every reference.
- HEAD every immutable reference; recheck viewer/generation before current. Verify S3 and
  Worker catalog/set/sample-bundle readback. Uncertain PUTs recover only with identical bytes.
  Restore exclusively owns its new directory, reserves in-flight bytes and rechecks pointer;
  failure removes only owned files. No automatic deletion/upgrade; explicit prune protects ancestors.
- Export exit 2 means incomplete input, not remote failure. --require-complete-input rejects
  current partial input before S3; historical partial rows remain visible without exit 2.
  Other CLI partial-row semantics remain. Conditional PUT protects concurrent processes.

## Cloud and Reader

[Smartphone procedure](../development/cloud-publication.md); no owner PC or agent credentials.
[Manual workflow](../../.github/workflows/publication.yml) serializes publication, rechecks successful
main CI/ci-gate after Environment protection, passes secret-free plan/index/objects by same-run ID.
R2 keys stay in credential steps of main-only Environment r2-publication, never repository
secrets/agents/chat/logs/source/Pages. Worker deployment requires separate cloud authorization.

Private R2; Reader allows only PublicKeySchema GET/HEAD/OPTIONS, no list/write/signing/engine.
JSON application/json; gzip application/gzip without Content-Encoding. no-transform; current
max-age=30, immutable max-age=31536000; exact Pages CORS. Viewer distinguishes missing/damaged/
unsupported/unavailable/visible 429 or 1027; CORS-hidden failures remain unavailable.

2026-09-25 [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard includes
10GB-month, 1M Class A/10M Class B monthly, free egress; [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)
100k/day account-wide. Monitor plans/usage/alerts; stop on budget/quota errors. Measure actual
costs/bytes/requests/URL/build/browsers/recovery/repeat publication; mocks do not suffice.
Project counters cannot cap unrelated traffic. The linked protocol retains earlier production
evidence, token approval, paid plans/invoices/alerts (not caps) and mobile/recovery measurements.

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

Journal before admission; finish only that execution. Retain history across days/killed workers.
Two attempts maximum; reservations consume attempts; refund only verified never-admitted work.
Reject missing history, changed reservations and rollback.

[Daily league](../../.github/workflows/league.yml): once/day, unchanged input with no eligible work
skips; manual dry-run writes nothing. Start requires current main's successful CI; finish rechecks
that CI and ancestry if main advanced. One r2-publication concurrency group; 64 partitions maximum,
4 concurrent jobs, 2 Workers/job, 25-minute computation deadline. Failed jobs preserve denominators;
received artifacts still finalize provisionally. Never rerun only failed jobs: new run attempts
cannot reuse old reservations. Same-run/attempt artifact IDs and archive hashes bind allowlisted
inputs/results; no DBs/environment. Retention 7 days; R2 history persists.

Private control/league-usage.json is excluded from Reader/prune and counts toward 8GB/500k.
Conditional, readback-verified leases precede transfers; never refund failures. Monthly caps:
900k Class A/9M Class B (10k control reserve); automation Worker 90k/day (1k probe reserve).
Budget restore from inventory and publication from verified files/receipts, including uncertain-PUT
GETs and Worker reads; one SDK attempt. Missing ledger with an existing journal requires recovery,
never a reset. This does not cap other clients/visitors or paid account base fees. #134 acceptance
still requires the real 7,600-slot Actions run, publication, viewer and measured costs.

## Measured capacity revision (2026-09-25)

[Pilot](../measurements/p5-league-pilot-linux.json): 4 characters/5 fields/2 placements/1 trial,
60 wins; 2 Workers, 32/28 sequential partitions: 63,382ms, 926 files/6,678,394 bytes.
Mean-scaled 7,600 slots: ~115k files/818MB, beyond 100k/256MB; not worst-case/production evidence.
Reviewed cap: 500k files including history; retain 8GB/1,000 slots per plan/512MiB work.
Estimate 128 slots/plan, 4s/600kB/44 files each, 24MB metadata/partition:
60 partitions, 6GB/335,183 files plus retention. Preflight cumulative requests;
actual limits stop underestimates without automatic expansion.
