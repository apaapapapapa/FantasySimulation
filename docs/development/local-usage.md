# Developer commands

[Smartphone publication](cloud-publication.md) needs no PC/`.env`.
[Startup](../../README.md), [tool pins](../../package.json), overrides: .env.example.
Paths are repo-relative. Vite proxies /api; API_PORT changes need restart.
The unauthenticated API binds loopback only.

## API (prefix /api)

```text
GET /health: Drizzle health
GET /characters: latest; limit <=100, cursor
GET /characters/{id}?revision=1: default latest
GET /rulesets, /scenarios
GET /revisions/{kind}/{id}/{revision}: immutable
POST /drafts: {kind,definitionId,base,definition}
GET /drafts/{id}
PATCH /drafts/{id}: {expectedVersion,definition}
POST /drafts/{id}/validate or /publish: {expectedVersion}
POST /battle-jobs: {spec,budget?}; 202 or cached 200
GET /battle-jobs/:id: state/attempt/progress/diagnostics/metrics
POST /battle-jobs/:id/cancel: commit cancellation before stopping worker
POST /battle-jobs/:id/retry: {expectedAttempts,budget}
GET /battle-results/:id: verified; missing/corrupt/quarantined: 503
POST /battle-results/:id/replay-recovery: {budget}
GET /replays/:id: manifest
GET /replays/:id/files/:file: allowlisted gzip; no Content-Encoding
```

Draft base: {id,revision,contentHash}, or null for new IDs. Stale edits, duplicate
publication and changed bases return 409. Incomplete drafts are allowed; publication
validates types/references and returns immutable revision plus draft. Published
revisions cannot change/delete. Job creation/replay recovery need X-Client-Id and
Idempotency-Key. [ADR 0007](../adr/0007-worker-runtime.md) owns runtime contracts;
[ADR 0006](../adr/0006-recorded-replay.md) owns recorded replay without engine execution.
Defaults/limits: [configuration](../../apps/api/src/config.ts).
Startup/db:seed adds missing IDs only; demo:spatial runs samples.
[ADR 0010](../adr/0010-battle-version-compatibility.md) governs published identities.

## Content authoring

Sources: `data/content/**/*.json`; output: `data/spatial/catalog.json`.
Preserve builtin-v1.json and published revisions. Files hold one revision or an array:
kind, id, revision, definition; schemaVersion defaults to 1. New revisions may omit
contentHash; supplied hashes must match. Authoring-only
`{"$ref":"status:soaked-v1:1"}` resolves dependencies; pinned refs do not rebind.
Duplicates, missing refs and cycles fail. Run `node scripts/spatial-catalog.ts --write`,
review field differences/affected revision IDs, then `vp run verify`.
Workbench shows structural differences.

## Batch

Use a clean commit/toolchain, no HTTP. Inputs: published revisions, <=1,000 slots,
calculation/output/work budgets. Command paths resolve in apps/cli:

```sh
vp run batch sample .generated/input.json
vp run batch plan .generated/input.json .generated/plan.json
vp run batch run .generated/plan.json .generated/output --workers 1
vp run batch check .generated/plan.json path/to/index.json .generated/output
vp run batch export .generated/plan.json .generated/public path/to/index.json .generated/output
```

--shard 0/4 through 3/4 needs separate outputs. Repeated inputs reuse verified results;
--retry-failed retries failed/cancelled slots. --deadline is milliseconds <=1,800,000.
Run prints immutable indexes; check/export accept more index/root pairs. Missing slots
stay pending. Exits 0/2/1: complete/incomplete/invalid. Keep .work private; disk needs
output and work budgets plus 256 MiB. Built CLI: node apps/cli/dist/batch.mjs (cwd paths).

## Publication

[Workflow](../../.github/workflows/publication.yml): cloud commands/environment;
[ADR 0008](../adr/0008-headless-batch.md): contracts. Restore needs a new directory.
Cleanup: `vp run publication prune public-dir`, review orphan keys/bytes, then --confirm.
Never remove .remote-lock while running. commit-unknown/committed-unverified need
identical-input retry/read-back. PUBLICATION_MAX_BYTES caps at 8GB; MAX_WRITES=10000,
MAX_TRANSFER_BYTES=256MB, MAX_WORKER_REQUESTS=200, MAX_RESTORE_BYTES=256MB
(all PUBLICATION_ prefixed). Default CLI exit: 2; Actions uses --require-complete-input.

Public build: VITE_PUBLICATION_ROOT, --mode public; default VITE_PUBLIC_BASE:
/FantasySimulation/. Hash links pin set/page/slot and preserve the attempt on reload.
The 100-row list sorts/filters per page ([load bytes](../measurements/match-list.json)).
Loopback URLs are local. build.json carries source/formats; CSP permits self/data only.
No API/DB/keys enter the build. Deploy/rollback needs successful main CI and ancestry;
reader deployment needs separate cloud authorization.
League overview loads summary only; battlefield/matchup tables load on selection.
Hash links pin snapshot/participants/page/slot through replay. Sorting is display-only;
provisional scores keep every scheduled slot. Actions/measurement: #134.
