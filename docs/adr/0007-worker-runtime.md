# ADR 0007: Persistent jobs and bounded Workers

P3 / #1, #10: single host; reusable Piscina 5.3.2 Workers compute, API owns SQLite
and artifacts. Workers receive no DB/root. Default 1/max 4 Workers leave >=1 CPU;
old+young JS heap 128MiB/Worker does not isolate WASM, external buffers or RSS.

## Persistence and execution

Freeze published manifest/simulationHash; store budgets separately. Match idempotency
key per client/endpoint/input (conflict 409). Fully verify ready artifacts against
canonical hashes; reuse only definitive win/draw. Short immediate transactions claim
token/10s lease, renewed ~3.3s. Reclaim changes token, at most 3 times; reject stale
completion. Persist cancellation before stopping the Worker. Default 30s timeout fails
and stops it; await I/O release. Explicit failed/cancelled/truncated retries bind
budget/expectedAttempts. Close records running failures; queued jobs resume on restart.

Worker pulls `simulate`, sends one target 128KiB NDJSON chunk (single-record exception
<=4,000,001 bytes), waits for ACK. API validates/compresses every record, rechecks
hashes/checkpoints and installs artifacts. Recheck token/live lease/cancellation before
one result/reference transaction. `BattleService` owns HTTP/batch admission, state,
verified results/replay; hide JobStore/Workers/roots. Completion/capacity notifications,
not read polling, wake waits; deadlines/shutdown unblock them. Share pure transition
validation with persistence/allowed operations; unsupported saved input cannot retry.

SQLite PID/hostname/token excludes concurrent coordinators. Bind root to persistent
store ID; reject foreign/nonempty unowned roots. Reclaim only after same-host old PID
exits; PID reuse or moved host/root fails conservatively without deletion. Only the
sole coordinator collects generated unreferenced UUID/staging directories. Keep DB
references; missing/corrupt records remain held for explicit recovery.

## Budgets and diagnostics

Defaults: 128 queued/running jobs, 16GiB storage. Reserve 20MiB/job (16MiB compressed
records + manifest 4MB); later failure diagnostics cannot consume those reservations.
Also reserve 20MiB/Worker for pending writes. API may lower caps; raising needs measured
ADR review. Sample RSS every 250ms; >1.5GiB stops admission/cancels execution, not an OS
hard cap. Report heap/external/ArrayBuffer/WASM linear-memory exports separately;
overlapping memory and process RSS must not be summed across Workers.

Measure initialization/computation/ACK wait/bytes/max chunk/cold-warm/full persistence;
TS/Rapier/boundary computation remains unseparated. Metrics never enter result hashes.
Corrupt results cannot silently recompute. Explicit replay recovery requires current
execution support and exact canonical resultHash; mismatch quarantines related
artifacts. Old engines return 409: no registry/conversion. `failure_code` forbids
nondeterministic retries; Drizzle 0003 only backfills that column from old diagnostics,
preserving saved bodies/results/replays. Typed missing/conflict/input/capacity/unavailable
storage errors are mapped to HTTP at the boundary.

`battle-runtime.test.ts`/`worker-pool.test.ts` cover process death/restart/duplicate
delivery/budgets/retries/cancel/timeout/corruption/recovery and Worker reuse/count hash
equality. Integrated 1,000-battle performance requires separate measurements.

`POST /api/battle-jobs/staged`: <=100 keyed requests, ordered NDJSON results.
`BattleService.runMany`: lazy unbounded total, only Worker-count inputs ahead of consumer;
capacity notifications, visible storage failure. Disconnect/early return cancels/drains
owned work. Batch owns plan/shard/index orchestration on this path; saved 1,000-slot plans
remain unchanged.
