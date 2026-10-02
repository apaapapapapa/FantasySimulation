# ADR 0019: Bounded league publication pipeline

**Accepted 2026-09-27; owner approval recorded in PR #214.** Refs #189 L5-01.
mainc99b043:#203/#210/#212/#213. Design only; existing
[publication](0008-headless-batch.md), [league](0015-league.md) and
[milestone](0016-p6-foundation.md) contracts remain active.
[Issue #189](https://github.com/apaapapapapa/FantasySimulation/issues/189)
owns the complete acceptance checklist and L5-02..07 dependencies.

## Proposed multipart reservation addendum (2026-10-02)

Refs #189. [v3 plan](../../scripts/league-transport-reservation.ts) uses runner-owned
byte streams, not <=3 artifacts/partition:4 runners/64 partitions,50 attempts/job/
256/run, deterministic existing8GB shares plus controls/framing/retry/retention.
Share exhaustion fails/retains old pointer; no record deletion, borrowing or engine
budget reduction. Quota only; v1/gates stay.

Stage1 reserves calibration jobs after CI/run authentication, before work:3/18/1
refs,40/76 plus existing refs; unchanged92MiB owner/history cap. SDK allocation debits immutable
name/ref/encoded bytes without refund/reset. Metrics snapshot excludes its own
reserved upload. SDK HTTP retries are separate.

Next: main-CI provenance for loaded encoder/Node closure; bounded framing/same sealed
ZIP upload (not re-encoding); version existing receiver/producer/finalizer with exact
identity/coverage/independent checks/original replay hashes/v1 recovery. PR#288 is
not multipart. Runtime/wire/receiver/lease/retry/storage/cost/270s gates stay closed:
no cloud trial/full-size/R2/Daily activation/300s claim.

## Evidence and gate

[Baseline](../measurements/l5-00-baseline.json):63 verified ZIPs/187 sidecars,
60 partitions/7,600 matches, run36285560434/1, source553b14a. ProcessCPU9740.752s
includes WorkerCPU3784.052s; computeMs3244.101s is stream.next elapsed, NOT CPU.
Correct earlier184-sidecar/9631s claims. Missing transport/Pages and recovery reuse preclude300s; no nested-span CPU/wall sums.

GO for design/pilots only. Floors:processCPU/(4N), WorkerCPU/(NW), N runners/W Workers;
at16/3:152.2/78.8s, excluding serial/I/O tails. Match wall includes waits. Scale-up requires re-measured critical path+waits<=270s.
Hold >4 runners or >=7,600 slots before R2; reuse is unknown before restore.
Release needs reviewed exact-source whole-wall/waits evidence<=270s. Profiles expire
one hour after Worker completion (checkpoint default), not a performance promise.

## Jobs and verification boundary

Two waves: admit -> {compute[N], transfer+finalize}. Merge probe/prepare; one input
artifact replaces61 uploads. Transfer polls alongside compute and finalizes itself;
no compute-needs barrier, no job starts after255s. Preserve whole-workflow r2-publication
exclusion (cancel-in-progress:false), other writers/recovery included; no lock split.

Admit pins main CI/source/viewer ancestry/engine+validator digests/input+plan/prior catalog/leases+journal. Keys stay in protected control/transfer,
never calculation/verifiers. Recheck CI after approval/before commit. Main-CI runtime
binds source/lock/runtime/native/WASM/archive hashes; no PR cache/results. Missing/
expired distribution uses measured frozen setup.

Retain128-slot partitions, <=64 partitions/<=1000 slots per plan. Deterministically
weight partitions across persistent runners, ties by ID;1..16-slot units preserve
slot/seed/attempt. Reuse pools, compare2/3/4 shared simulation/verifier Workers on
one runner before targeting16; no extra CPU pool.32 requires measured benefit and
actual account headroom, never inferred from ChatGPT.

EVERY replay: a distinct engine-free verifier reopens bytes for structure/semantics/
privacy. Reuse representation in its producer, no central re-decode. Checks records,
not computation. Bind source/workflow/run/attempt, validator version/digest,
engine/digest, plan/partition/slot/simulation/attempt, outcome, replay/pack/index
hashes/bytes. Authenticate GitHub run/head/jobs/attempt and artifact ID/digest;
producer JSON/hash alone is insufficient. Check actual archive/pack/entry bytes,
assignment/coverage; rehash PUT bytes, not mtime/path. Commit needs terminal receipts
matching successful producer jobs; otherwise only stage. Missing/stale/foreign proof
rejects or fully validates. Approved producers can lie: retain review/CI corruption controls.

## Packs and Reader

Publication v2 advertises packed refs. Dual readers preserve v1 URLs/bytes/replay
identity; never silently extend strict v1 or execute historical engines. Allowlist:
packs/<sha256>.bin, pack-indexes/<sha256>.json. Concatenate existing independent gzip
chunks/checkpoints AND receipt/manifest JSON without recompression. Canonical index
<=4MB binds version/pack hash+size/unique logical key/offset+length/entry SHA256/
encoding/expanded bound; no self-hash cycle. Rows bind index hash+bytes/original replay
identity. Reject unsafe integers, overflow, overlap, duplicate/missing entries,
bad ranges/hash/size and decode overflow.

Sort slots into fixed64-slot groups within each partition, then entry keys. Flush
before16MiB target/32MiB hard cap at entry boundaries. Large replays span packs;
oversized entries fail. Spool validated entries to bounded owned disk. Terminal means compute/validation, not DB commit. Release queue capacity on durable
spooling to avoid64-slot group/2-unit queue deadlock. Close groups in fixed order after all slots finish;
preserve pack/catalog hashes. Retain artifacts; retries create new immutable packs.
Count ALL indexes/set/pair/league/control files toward<=1000 new objects, not just
119 packs; exceeding target requires timing re-evaluation.

Browser ranges avoid index lookups. GET requires bytes=start-end;
suffix/open/multipart/overflow/out-of-bounds returns416. Return206 with exact
Content-Range/Length, Accept-Ranges, ETag. HEAD gives whole metadata without body.
Range cap=min(existing replay fetch bound,32MiB); unbounded GET rejects. CORS allows
Range/exposes range/length/ETag, exact origin/no-transform/immutable cache/no
Content-Encoding for gzip. Verify R2's actual range/length (shortened reads possible).
Browser verifies index/entry before decode;200 fails without whole-pack fallback. Keep max-age30. Consider Worker-resolved200 only if browser pilots fail.

## Persistence, streaming and history

Serialize claims/capacity/metadata commits. Unsaved queue<=2 units AND64MiB, with
backpressure before admission. Workspace512MiB/process1.5GiB abort includes DB/WAL/
temp/Buffer/WASM/copies; oversize streams within bounds or fails. Drain on failure/
abort. fsync pack/index, atomic link/rename, directory sync BEFORE DB completion/
artifact exposure. Missing packs never recover as success; orphans stay unreferenced.
Compare checkpoint thresholds at safe commits; keep sync durability. WAL changes need benefit/crash tests.

Unique run/attempt/runner/sequence artifacts, ZIP level0, pinned ID/digest, no overwrite.
Bound polling/pages/deadline/API calls, empty polls/retries included. Initial proposals:
256 artifacts/run with controls,32/producer,64MiB/archive,200 metadata API calls.
Preflight service/download/storage quotas. If actual per-job cap is10, regroup before
execution; do not assume32. Measure secret-free upload/download/visibility. Final
receipts enumerate all refs; transfer payload queue starts64MiB, stops/drains on
error/budget. Staged hash URLs are public, never a secrecy boundary.

Before PUT, validate producer/bytes/privacy and reserve capacity/durable usage lease.
Prove stored refs with actual bytes/ETag/acknowledged PUT under existing rules.
Count uncertain PUT/retry/readback, no refund/reset. Finalizer reconciles all slot/
attempt/result/pack with exact BigInt scoring. Performance requires7600 win/draw,
one next attempt/execution, unchanged provisional counts. Recheck generation/viewer;
conditional catalog/current PUT last. Errors/conflicts retain old pointer. Recovery
uses identical bytes/original execution, fresh leases/generation checks: no simulation,
new attempt, deletion or forced publication.

Incremental admission needs immutable catalog-bound ancestor-chain checkpoint of
replay/pack refs/results/attempts/validator, established by trusted committed run.
Persist provenance in private control, not only expiring artifacts. First legacy
adoption fully audits within its wall/budget; later admission verifies chain/provenance/
journal/deltas. Invalid/missing proof fully audits or rejects; hash alone is not trust.
Historical corruption may be detected only on read/full audit: approve audit schedule/
budget before changing detection boundary. Preserve history/leases.

## Amendments and delivery gates

ADR0008 amendments: four-stage DAG/4-job/2-Worker/25-minute caps, full-graph transfer/central replay validation. Retain64 partitions,
1000 slots/plan,8GB/500k retention,900k A/9M B per billing cycle,90k Worker/day,
1000 readbacks/run,two attempts/workflow exclusion.300s acceptance does not shorten
safe recovery deadlines or change failed/cancelled outcomes. Other changes need review.

Usage v2 retains v1 leases (cap256). LEAGUE_BILLING_OBSERVATION binds account/exact
UTC cycle/fresh1h usage+reserves; unknown rejects before R2. Observed usage plus
leases count conservatively without refunds. Worker allowance is day-bound, storage/
CPU proof separate, cycle updates adjacent.

2026-09-27 [public Linux](https://docs.github.com/en/actions/reference/runners/github-hosted-runners):
4CPU/16GB; [limits](https://docs.github.com/en/actions/reference/limits):Free20/Pro40/Team60 jobs,
GITHUB_TOKEN1000 calls/hour/repo. [upload-artifact](https://github.com/actions/upload-artifact#number-of-artifacts)
says500/job; [toolkit](https://github.com/actions/toolkit/blob/main/packages/artifact/README.md)
says10. Resolve pinned6.2.1 by pilot; account/storage headroom/competing CI unknown.
[R2 ranges](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads)
are supported, not measured throughput. No billing/permission expansion.

Implement L5-02 verifier/queue/pool, L5-03 dual schemas/pack/Reader/browser, L5-04
assignment/distribution pilots, L5-05 streaming/leases/recovery, L5-06 metadata/finalizer,
then L5-07 acceptance. ADR approval precedes contract code; retain Issue gates.
Worker deployment requires separate approval via smartphone Actions/Cloudflare:
dual Reader -> dual Pages -> old playback check -> first pack publication. Record
SHA/features before pointer switch; rollback retains v2 readability.

Issue sections6/8 own correctness/failure/compatibility/5-field acceptance. Pre-register
fixed source/inputs/seeds,5 paired trials,retain failures. Require measured270s
critical path/capacity before full trials: cold1+warm2, empty namespaces/reuse0,
preapproved budget/prune/run cap; production at one milestone. Start=workflow
created_at (requestedAt/schedule lag separate); end=fresh browser normal URL/new
snapshot/replay after all ref proofs/bounded Reader readback. Include approval/
runner/exclusion/cache waits, no cache buster; old-browser30s lag separate. Issue
section3 targets remain, not measured promises; #189 stays open through full acceptance.
