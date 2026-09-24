# Local usage

These are optional developer commands, not requirements for the owner. For smartphone-only
operation, use [cloud publication](cloud-publication.md); do not ask the owner to create a local `.env`.
Start with [README](../../README.md); pinned versions/scripts are in
[package.json](../../package.json). Copy `.env.example` to root `.env` only for overrides.
DB paths are repository-relative. Vite proxies `/api`; restart after changing `API_PORT`.
The unauthenticated API listens on loopback only.

## Build and edit

`vp run build`, then `vp run --filter @fantasy/api start` and, separately,
`vp run --filter @fantasy/web preview` (<http://127.0.0.1:4173>).
Outputs: app `dist`. Run inside the repo for `db/drizzle` and `data/spatial`.
Native SQLite builds require Python/C++.

UI: edit/validate drafts, publish immutable revisions, manage seeded battles/cancel/retry.
Saved IDs reopen drafts. Replay controls step/speed/camera without engine execution
([ADR 0006](../adr/0006-recorded-replay.md)). Increase the budget to retry truncated jobs.

All routes below use `/api`.

| API                                      | Contract                        |
| ---------------------------------------- | ------------------------------- |
| `GET /health`                            | Startup/Drizzle health          |
| `GET /characters`                        | Latest; limit <=100, cursor    |
| `GET /characters/{id}?revision=1`        | Revision; default latest        |
| `GET /rulesets`, `/scenarios`            | Rules/scenarios                 |
| `GET /revisions/{kind}/{id}/{revision}`  | Fixed definition                |
| `POST /drafts`, `GET /drafts/{id}`       | Create/read draft               |
| `PATCH /drafts/{id}`                     | `{expectedVersion, definition}` |
| `POST /drafts/{id}/validate`, `/publish` | Publish: `{expectedVersion}`    |

Create drafts with `{kind, definitionId, base, definition}`. `base` is the original
`{id, revision, contentHash}`, or null for new IDs. Stale edits, duplicate publication
or another draft changing the base return 409. Drafts may be incomplete; publication
validates types/references and returns an immutable revision plus updated draft.
Published revisions cannot be overwritten/deleted.

## Samples and asynchronous API

`pnpm demo:spatial` demonstrates sword/flying mage in pillars; custom example:
`pnpm demo:spatial archer guardian flat`. `data/spatial/catalog.json` contains 15
characters/69 revisions. `pnpm catalog:spatial` checks it; review `--write` changes.
Use new IDs per [version policy](../adr/0010-battle-version-compatibility.md).
Startup/`db:seed` adds missing IDs. Manifests include only reachable revisions, so
unrelated additions do not change battle hashes. Scenarios include flat and pillars.

[ADR 0007](../adr/0007-worker-runtime.md) owns leases, reservations, recovery,
result conflicts and cache. Under `/api`; creation and replay recovery require
`X-Client-Id` and `Idempotency-Key`:

| API                                            | Contract                                       |
| ---------------------------------------------- | ---------------------------------------------- |
| `POST /battle-jobs`                            | `{spec,budget?}`; 202 or cached 200            |
| `GET /battle-jobs/:id`                         | State/attempt/progress/diagnostics/metrics     |
| `POST /battle-jobs/:id/cancel`                 | Commit cancellation, then stop worker          |
| `POST /battle-jobs/:id/retry`                  | `{expectedAttempts,budget}`                    |
| `GET /battle-results/:id`                      | Verified; missing/corrupt/quarantined: 503     |
| `POST /battle-results/:id/replay-recovery`     | `{budget}` plus idempotency headers            |
| `GET /replays/:id`, `/replays/:id/files/:file` | Manifest/allowlisted gzip; no Content-Encoding |

Defaults: `ARTIFACT_PATH=./data/replays`, `BATTLE_WORKERS=1`, `BATTLE_TIMEOUT_MS=30000`,
`BATTLE_QUEUE_LIMIT=128`, `BATTLE_STORAGE_BYTES=17179869184`, `BATTLE_RSS_BYTES=1610612736`.

## Batch and publication

Create/execute plans on the same clean commit/toolchain; no HTTP needed. Inputs carry
published revisions, <=1,000 slots, calculation budget and output/work capacity.
Commands run in `apps/api`, so relative arguments resolve there:

```sh
vp run batch sample .generated/input.json
vp run batch plan .generated/input.json .generated/plan.json
vp run batch run .generated/plan.json .generated/output --workers 1
vp run batch check .generated/plan.json path/to/index.json .generated/output
vp run batch export .generated/plan.json .generated/public path/to/index.json .generated/output
```

Use `--shard 0/4` through `3/4` with separate outputs. Repeating plan/output reuses
verified results. `--retry-failed` explicitly retries failed/cancelled slots;
`--deadline` is milliseconds, <=1,800,000. Run prints immutable index paths.
Check/export accept additional index/root pairs. Missing slots remain pending;
exit 0 complete, 2 incomplete, 1 invalid. `.work/` remains private; disk needs output
limit + work limit +256 MiB. [ADR 0008](../adr/0008-headless-batch.md) owns the contracts.
Built CLI: `node apps/api/dist/batch.mjs` (arguments relative to current directory).

R2 publication normally runs through [protected Actions](cloud-publication.md).
The CLI reads process environment variables, not a mandatory `.env`:
`R2_ACCOUNT_ID`, `R2_BUCKET=fantasysimulation-replays`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`. Store production keys in Environment `r2-publication` only;
never in commits, chat, agent development environments, logs or browser builds.
Set `PUBLICATION_VIEWER_URL=https://apaapapapapa.github.io/FantasySimulation/` and
`PUBLICATION_WORKER_URL=https://fantasysimulation-replay-reader.tokyojp.workers.dev/`.
The runtime Git graph must contain the deployed viewer SHA (Actions uses full history).

```sh
# Fresh runtime only: restore retained data into a directory that does not yet exist.
vp run publication restore .generated/public
vp run publication publish .generated/plan.json .generated/public path/to/index.json .generated/output --dry-run
vp run publication publish .generated/plan.json .generated/public path/to/index.json .generated/output
vp run publication prune .generated/public
# Review orphan keys/bytes; only then explicitly delete:
vp run publication prune .generated/public --confirm
```

Restore validates all retained data and expanded privacy, refuses existing directories,
and removes only its own incomplete output on failure. `PUBLICATION_MAX_RESTORE_BYTES`
defaults to 256MB (caps at 8GB); transport request/deadline bounds also apply.
Publish runs batch check/export first. One administrator runs publish/cleanup sequentially;
`public-dir.remote-lock` must be removed manually only after confirming no process remains.
Interrupted uploads resume with the same inputs. `commit-unknown` or `committed-unverified`
means rerun/read-back is required, not success. Exit 2 preserves incomplete rows honestly.
`PUBLICATION_MAX_BYTES` defaults/caps at 8GB; writes default 10,000, transfer 256MB,
Worker read-back 200 requests (`PUBLICATION_MAX_WRITES`, `_TRANSFER_BYTES`, `_WORKER_REQUESTS`).
Retries/deadlines and conditional writes are bounded.

## Public viewer and reader

Build: `VITE_PUBLICATION_ROOT=https://<reader>.workers.dev/ vp run --filter @fantasy/web build --mode public`.
Base defaults `/FantasySimulation/`; `VITE_PUBLIC_BASE=/` supports a custom domain.
Hash routes survive reload. `build.json` carries source SHA/formats; CSP permits self/data
origin only. Static output has no API/DB/credentials. Data CORS permits the viewer origin.
`Public viewer` checks successful main push CI/ci-gate before build and deploy.
Manual rollback requires a successful main CI run ID and verified main ancestry.
Reader: `vp run --filter @fantasy/replay-reader build`, then
`vp run --filter @fantasy/replay-reader deploy` using separately authorized cloud tooling,
not the owner's PC. Keep R2 public access disabled; the reader validates GET/HEAD/OPTIONS keys without listing.
