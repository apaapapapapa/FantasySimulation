# ADR 0019: Bounded league publication pipeline

**Accepted 2026-09-27; owner approval recorded in PR #214.** Refs #189 L5-01.
Main c99b043 includes #203/#210/#212/#213. Design/evidence only; existing
[publication](0008-headless-batch.md), [league](0015-league.md) and
[milestone](0016-p6-foundation.md) contracts remain active.
[Issue #189](https://github.com/apaapapapapa/FantasySimulation/issues/189)
owns the complete acceptance checklist and L5-02..07 dependencies.

## Evidence and gate

[Baseline](../measurements/l5-00-baseline.json) binds 63 verified ZIPs, 187 sidecars,
60 partitions and 7,600 matches to run36285560434/1, source553b14a. Process CPU9740.752s
includes Worker CPU3784.052s; computeMs3244.101s is elapsed stream.next, NOT CPU.
Nested spans cannot be added as CPU/wall. Correct earlier184-sidecar/9631s claims.
Missing original transport/Pages evidence and recovery reuse preclude300s acceptance.

GO for design/pilots only. CPU floors:processCPU/(4N), WorkerCPU/(NW) for N runners/W Workers;
at16/3:152.2/78.8s, excluding serial/I/O tails. Match wall includes waits, not pure task CPU.
Re-measure; scale-up requires critical path plus waits<=270s, not summed inclusive spans.

Admission holds >4 runners or >=7,600 slots before R2; reuse is unknown before restore.
Compute-only hints cannot authorize capacity. Release requires a reviewed exact-source <=270s
whole-wall/waits protocol. Profiles expire one hour after
Worker completion (checkpoint default): a deadline, no promise.

## Jobs and verification boundary

Two waves: **admit -> {compute[N], transfer+finalize}**. Merge probe/prepare; one
input artifact replaces61 uploads. Transfer starts alongside compute (no compute
needs barrier), polls completion and finalizes itself; no job starts after255s.
Retain whole-workflow r2-publication exclusion, cancel-in-progress:false, including
other writers/recovery. No lock split initially.

Admit pins main CI/source, viewer ancestry, engine/validator digests, input/plan,
prior catalog and durable leases/journal. Keys only in protected control/transfer
steps, never calculation/verifiers. Recheck CI after approval/before commit.
Main-CI distribution binds source/lock/runtime/native/WASM/archive hashes; no PR
cache/results. Expired/missing distribution uses measured frozen setup.

Retain128-slot partitions, <=64 partitions, <=1000 slots/plan. Weight partitions
deterministically (ties by ID) across persistent runners;1..16-slot work units do
not affect slot/seed/attempt. Reuse pools; compare2/3/4 shared simulation/verifier Workers
on one runner before targeting16; no extra CPU pool.32 needs measured benefit
and actual account headroom, never inferred from ChatGPT.

For EVERY replay, a distinct existing engine-free verifier reopens produced bytes
and checks structure/semantics/privacy. Share its verified representation in that
producer; central finalizer does not decode every replay again. This independently
checks records, not engine computation. Evidence binds source/workflow/run/attempt,
validator version/digest, engine/digest, plan/partition/slot/simulation/attempt,
outcome, replay/pack/index hashes and bytes. GitHub run/head/jobs/attempt and immutable
artifact ID/digest authenticate the boundary; producer JSON/hash alone never suffices.
Transfer checks actual archive/pack/entry bytes and assignment/coverage; rehash bytes
being sent at PUT, not mtime/path. Terminal receipts must match successful producer
jobs before formal commit; unfinished/failed-job packs can only be staged.
Missing/stale/foreign evidence rejects or explicitly falls back to full validation.
Compromised approved producers can lie; retain independent review/CI corruption controls.

## Packs and Reader

Publication v2 explicitly advertises packed refs; dual readers retain v1 URLs/bytes/
replay identity. Never silently extend strict v1 schemas or execute historical engines.
Proposed allowlist: packs/<sha256>.bin, pack-indexes/<sha256>.json. Concatenate existing
independent gzip chunks/checkpoints AND receipt/manifest JSON, without recompression.
Canonical index<=4MB: version, pack hash/size, unique logical key, offset/length,
entry SHA256, encoding, expanded-size bound. No self-hash/index-pack cycle.
Rows bind index hash/bytes and original replay identity. Reject unsafe integers,
overflow, overlap, duplicate/missing entries, bad ranges/hash/size and decode overflow.

Sort slots into fixed groups of64 within each partition; sort entry keys and flush
before16MiB target/32MiB hard cap at existing entry boundaries. Large replays span
packs; oversized entries fail. Spool validated entries to bounded owned disk; terminal
here means computation/validation done, not DB commit. Release queue capacity on durable
spooling so a64-slot group cannot deadlock behind the2-unit queue. Close groups in fixed
order after all slots finish; preserve pack/catalog hashes. Keep artifacts; retries create
new immutable packs. Count ALL indexes/set/pair/league/control files toward<=1000
new objects; not merely119 packs. Exceeding the target requires timing re-evaluation.

Browser single-range reads avoid Worker index lookups. Pack GET requires bytes=start-end; reject suffix/open/
multipart/overflow/out-of-bounds with416. Return206 with exact Content-Range/Length,
Accept-Ranges, ETag; HEAD reports whole-object metadata without body. Range cap is
min(existing replay fetch bound,32MiB). Reject unbounded pack GET.
CORS allows Range and exposes range/length/ETag; preserve exact origin, no-transform,
immutable cache and no Content-Encoding for gzip. Verify R2 returned range/length
(shortened reads are possible). Browser verifies index and selected entry before
decode; unexpected200 is failure, never whole-pack fallback. Keep current max-age30.
Reconsider Worker-resolved200 only if browser pilots fail.

## Persistence, streaming and history

Serialize claims/capacity/metadata commits. Unsaved queue<=2 work units AND64MiB;
backpressure before admission. Keep512MiB workspace/1.5GiB process abort; account for
DB/WAL/temp/Buffer/WASM/copies. Oversize streams within bounds or fails. Drain admitted
work on failure/abort. fsync pack/index, atomic link/rename and directory sync BEFORE
DB completion/artifact exposure. Missing packs cannot recover as success; orphan files
remain unreferenced. Compare checkpoint thresholds at safe commits; keep synchronous
durability and require measured benefit/crash tests before changing WAL policy.

Unique run/attempt/runner/sequence artifacts, ZIP level0; pin ID/digest, no overwrite.
Bound polling/pages/deadline/API calls, including empty polls/retries. Initial proposals:
256 artifacts/run including controls,32/producer,64MiB/archive,200 metadata API calls;
preflight service quotas plus downloads/storage. If actual per-job cap is10, regroup
bounded artifacts before execution; do not assume32 is supported. Measure visibility/
upload/download delay in a secret-free live pilot. Final producer receipts enumerate
all artifacts. Transfer payload queue initially64MiB; stop/drain on error or budget.
Staged hash URLs are publicly readable, never a secrecy boundary.

Before PUT validate producer/bytes/privacy, reserve capacity and durable usage lease.
Prove all stored refs by actual bytes/ETag/acknowledged PUT under existing rules;
count uncertain PUT/retry/readback, no refunds/reset. Finalizer reconciles every
slot/attempt/result/pack, then uses existing exact BigInt scoring. Performance acceptance
needs7600 win/draw, one next attempt per execution; provisional counts remain unchanged.
Recheck generation/viewer; conditional catalog/current PUT last. Conflict/error retains
old pointer. Recovery uses identical bytes/original execution plus fresh leases and
generation checks: no simulation/new attempt/deletion/forced publication.

Incremental admission requires immutable catalog-bound checkpoint of ancestor chain,
replay/pack refs, results, attempts and validator identity, established by a trusted
committed run. Store provenance durably in private control, not only expiring artifacts.
First legacy adoption requires full audit, included in that run's wall/budget. Later
admission verifies provenance/chain/journal/deltas; invalid/missing proof triggers full
audit or rejection. Hash alone never manufactures trust. Untouched historical payload
corruption may be detected only on read/full audit; approve audit schedule/budget before
enabling this changed detection boundary. Preserve old history/leases.

## Amendments and delivery gates

Amend ADR0008's four-stage DAG,4-job/2-Worker caps,25-minute computation budget,
full-graph-before-transfer and central full replay validation. Retain64 partitions,
1000 slots/plan,8GB/500k retention,900k A/9M B monthly,90k Worker/day,1000 readbacks/run,
two attempts and workflow exclusion.300s acceptance does not shorten safe recovery
deadlines or change failed/cancelled outcomes. Other changes need a reviewed diff.

2026-09-27: [public Linux](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
4CPU/16GB; [limits](https://docs.github.com/en/actions/reference/limits)
Free20/Pro40/Team60 jobs; GITHUB_TOKEN1000 API calls/hour/repo.
[upload-artifact](https://github.com/actions/upload-artifact#number-of-artifacts) says500/job;
[toolkit](https://github.com/actions/toolkit/blob/main/packages/artifact/README.md) says10.
Resolve for pinned6.2.1 by pilot. Account/storage headroom and competing CI remain unknown.
[R2 ranges](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads)
are supported; documentation is not measured throughput. No billing/permission expansion.

Implement L5-02 verifier/queue/pool, L5-03 dual schemas/pack/Reader/browser, L5-04
assignment/distribution pilots, L5-05 streaming/leases/recovery, L5-06 metadata/finalizer,
then L5-07 acceptance. ADR approval precedes contract code; each phase retains Issue gates.
Separate approval for Worker deployment via smartphone Actions/Cloudflare steps:
dual Reader -> dual Pages viewer -> old playback check -> first pack publication.
Record deployed SHA/features before pointer switch; rollback must retain v2 readability.

Issue §6/8 owns all correctness/failure/compatibility/5-field pilot acceptance;
pre-register fixed source/inputs/seeds, 5 paired trials and retain all failures.
Require measured270s critical path/capacity before full trials: isolated cold1+warm2,
empty namespaces/reuse0, preapproved budget/prune/run cap; production at one milestone.
Start=workflow created_at; requestedAt/schedule lag separate. End=fresh browser uses
normal URL/new snapshot/replay after all ref proofs and bounded Reader readback.
Include approval/runner/exclusion/cache waits, no cache buster; old-browser30s lag separate.
Issue §3 targets remain, not measured promises. #189 stays open through full acceptance.
