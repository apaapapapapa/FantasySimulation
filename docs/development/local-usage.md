# Optional developer commands

The owner uses [smartphone-only publication](cloud-publication.md), not a PC or `.env`.
[README](../../README.md) covers startup; [package.json](../../package.json) pins tools.
Optional overrides use .env.example. Paths are repo-relative; Vite proxies /api.
Restart after API_PORT changes; the unauthenticated API binds loopback only.

## API (all paths prefixed /api)

```text
GET /health                            startup/Drizzle health
GET /characters                        latest; limit <=100, cursor
GET /characters/{id}?revision=1         revision; default latest
GET /rulesets, /scenarios               definitions
GET /revisions/{kind}/{id}/{revision}   immutable revision
POST /drafts                           {kind,definitionId,base,definition}
GET /drafts/{id}                        draft
PATCH /drafts/{id}                      {expectedVersion,definition}
POST /drafts/{id}/validate or /publish  {expectedVersion}
POST /battle-jobs                       {spec,budget?}; 202 or cached 200
GET /battle-jobs/:id                    state/attempt/progress/diagnostics/metrics
POST /battle-jobs/:id/cancel            commit cancellation before stopping worker
POST /battle-jobs/:id/retry             {expectedAttempts,budget}
GET /battle-results/:id                verified; missing/corrupt/quarantined: 503
POST /battle-results/:id/replay-recovery {budget}
GET /replays/:id                        manifest
GET /replays/:id/files/:file            allowlisted gzip; no Content-Encoding
```

Draft base is {id,revision,contentHash}, or null for new IDs. Stale edits/duplicate publication/
changed bases return 409. Drafts may be incomplete; publication validates types/references
and returns an immutable revision plus draft. Published revisions cannot change/delete.
Job creation/replay recovery require X-Client-Id and Idempotency-Key.
[ADR 0007](../adr/0007-worker-runtime.md) owns runtime contracts;
[ADR 0006](../adr/0006-recorded-replay.md) owns saved replay without engine execution.
Defaults: ARTIFACT_PATH=./data/replays, BATTLE_WORKERS=1, BATTLE_TIMEOUT_MS=30000,
BATTLE_QUEUE_LIMIT=128, BATTLE_STORAGE_BYTES=17179869184, BATTLE_RSS_BYTES=1610612736.
Use demo:spatial/catalog:spatial scripts for samples; review catalog --write. Startup/db:seed
adds missing IDs only. [ADR 0010](../adr/0010-battle-version-compatibility.md) governs IDs.

## Batch

Use the same clean commit/toolchain, no HTTP. Inputs carry published revisions, <=1,000 slots
and calculation/output/work budgets. Paths below resolve in apps/cli:

```sh
vp run batch sample .generated/input.json
vp run batch plan .generated/input.json .generated/plan.json
vp run batch run .generated/plan.json .generated/output --workers 1
vp run batch check .generated/plan.json path/to/index.json .generated/output
vp run batch export .generated/plan.json .generated/public path/to/index.json .generated/output
```

--shard 0/4 through 3/4 needs separate outputs. Repeated inputs reuse verified results;
--retry-failed explicitly retries failed/cancelled slots. --deadline is milliseconds <=1,800,000.
Run prints immutable indexes; check/export accept more index/root pairs. Missing slots stay
pending. Exits 0/2/1 mean complete/incomplete/invalid. Keep .work private; disk needs output
and work budgets plus 256 MiB. Built CLI: node apps/cli/dist/batch.mjs, paths relative to cwd.

## Publication

[Workflow](../../.github/workflows/publication.yml) owns cloud commands/environment variables;
[ADR 0008](../adr/0008-headless-batch.md) owns contracts. Restore requires a new directory.
Cleanup is explicit: `vp run publication prune public-dir`, review orphan keys/bytes, then
add --confirm. Never remove .remote-lock while its process runs. commit-unknown and
committed-unverified require identical-input retry/read-back. PUBLICATION_MAX_BYTES caps at
8GB; MAX_WRITES=10000, MAX_TRANSFER_BYTES=256MB, MAX_WORKER_REQUESTS=200,
MAX_RESTORE_BYTES=256MB (all PUBLICATION_ prefixed). CLI exit 2 remains the default;
Actions uses --require-complete-input.

Public web build uses VITE_PUBLICATION_ROOT and --mode public; base /FantasySimulation/ is
overridable by VITE_PUBLIC_BASE=/. Hash routing survives reload. build.json carries source/formats;
CSP permits self/data origin only. No API/DB/keys enter the build. Public viewer requires successful
main CI; rollback requires that run ID/ancestry. Reader build/deploy uses separate cloud authorization.
