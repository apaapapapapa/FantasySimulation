# Developer commands

[Smartphone publication](cloud-publication.md) needs no PC/`.env`.
[Startup](../../README.md), [tool pins](../../package.json), overrides: .env.example.
Paths are repo-relative. Vite proxies /api; API_PORT changes need restart.
The unauthenticated API binds loopback only.

## API (prefix /api)

Health, catalog/revisions, drafts, battle jobs/results and replay files: exact methods,
paths and validators live in [HTTP routes](../../apps/api/src/http/app.ts) and
[job routes](../../apps/api/src/http/job-routes.ts).

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
JSON holds a revision or array: kind, id, revision, definition; schemaVersion defaults to 1.
Omit contentHash to generate it; supplied hashes must match.
`{"$ref":"status:soaked-v1:1"}` resolves refs; pinned refs never rebind.
Preserve builtin-v1.json and published revisions. Duplicate IDs, missing refs and cycles fail.
Run `node scripts/spatial-catalog.ts --write`; review field diffs, affected IDs and hashes.
Append new IDs/hashes to `data/spatial/published-revisions.json` before `vp run verify`.

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
League overview loads summary; tables load on selection. Hash links pin snapshot/
participants/page/slot/`/steps/N`. `#/local` plays replay files in-browser.
Sorting is display-only; provisional scores keep every scheduled slot. Actions: #134.
For a read measurement, opt in with `?publication-metrics=1` before the hash.
Console `FANTASY_PUBLICATION_READ` records count each attempted main-thread public
read and bounded response body bytes/time. It adds no requests or persistent storage.
Bytes exclude headers, app assets, compression on the wire and cancelled partial bodies;
replay Worker reads are outside this scope. A response record alone is not validation success.
