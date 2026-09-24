# ADR 0008: Fixed plans, result bundles and publication

Headless execution shares published revisions, BattleRuntime, Piscina and the engine.
The [adopted plan/capacity/resume contract](https://github.com/apaapapapapa/FantasySimulation/blob/e9325df8ca62beba39b85d100265379e4c5ad2fb/docs/adr/0008-headless-batch.md)
remains authoritative for execution, capacity, deadlines, shards, durability, ownership,
retry and recovery. This summary changes none of those rules or engine decisions.

`batch check` verifies every planned slot, source, shard, receipt and file: exit 0 complete,
2 incomplete, 1 invalid. No indexes means all pending. Hashes are not authentication.
Historical engine IDs are readable; execution requires current engine/source/digest and
reconstruction equality. No historical execution.

## Publication contract v1 (#81 / #80)

Zod/types: `packages/domain/src/spatial/publication.ts`. Platform I/O is excluded;
web owns ReplaySource/OpenedReplay. Strict schemaVersion=1 rejects unknown versions/fields.

| Key (hash = 64 hexadecimal SHA-256 digits) | Content                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `catalog/current.json`                     | Current catalogHash and decoded bytes                                   |
| `catalog/<hash>.json`                      | Previous catalogHash (initial null), sorted setHash/bytes, <=1,000 sets |
| `sets/<setHash>/set.json`                  | Source, conditions, counts, page references                             |
| `sets/<setHash>/<pageHash>.json`           | planId/index; slotId-sorted rows, 100/page except last, <=10 pages      |
| `objects/<objectHash>/...`                 | Original receipt/manifest/chunk/checkpoint bytes                        |

New JSON is canonical UTF-8 without newline; names hash the entire file without a
self-hash field. Pages omit setHash to avoid cycles. JSON checksums bind decoded HTTP
bytes; gzip checksums bind compressed bytes. Existing objectHash still hashes the canonical
receipt body excluding objectHash. PublicReplayRef stores the receipt's actual byte size/hash
and manifestChecksum. Verify bytes before shared row/receipt/manifest and set/page bindings.

Rows carry slot/simulation IDs, named character/scenario revisions, placement/orientation,
actor RNG streams, ruleset, seed, state/reason/reused, outcome/steps and replay references,
records/lastVerifiedStep. Complete is full playback; unresolved/truncated is verified partial
playback. Failed/pending has null result/reference, zero records and unavailable playback.
Never invent IDs or omit missing-shard pending rows. Reasons are fixed codes; raw batch
errors and cancelled diagnostics do not enter this bundle contract. New reaction state
belongs in the existing versioned display records, not copied into list rows.

## Local export

See [commands](../development/local-usage.md). Export reuses batch check without SQLite,
engine execution, Git checkout or network. It binds plan/index/receipt references, revision
hashes, manifest input and row conditions. Schemas allowlist public fields; JSON and expanded
gzip are additionally scanned for absolute paths, private fields and known credential forms.
This cannot detect every arbitrary secret: administrators supply only publishable definitions.
Never copy `.work/`, DBs, environment, drafts or arbitrary files.

Preflight all collisions/capacity before object -> page -> set -> catalog -> current.
Reuse identical bytes; stop on different bytes or a different resultHash for one simulation.
Repeated sets keep their generation. New sets retain prior generations/links; no auto-delete.
Limits: 8,000,000,000 stored bytes including pointer staging, 100,000 files. Multi-object
writes are not atomic. Separate output from input; reject symlinks/non-layout keys.
One local writer lock plus current recheck protects replacement. Rerun after exceptions;
remove a crash-left lock only after confirming the writer stopped. Exit 2 still commits
an export with every planned slot; it does not mean complete calculation or remote publication.

## R2 transport and operating bounds

The explicit publisher uses pinned official AWS S3 SDK signing, conditional PUT,
three maximum attempts and a five-minute deadline. Credentials grant only this bucket's
object read/write. No upload API is exposed by the reader.
Before writes: reconcile/export, validate all retained graphs/files/privacy, inventory,
collision/result identity, source ancestry and viewer format, then capacity/request budgets.
Upload objects/pages/sets/catalogs, HEAD every referenced file, recheck generation/viewer,
and replace current with If-Match (first publish If-None-Match). Identical bytes are reused.
S3 and reader catalog/set/sample-bundle read-back must pass before reporting verified.
Conditional response loss is explicitly uncertain; rerun the same inputs. No auto-delete;
explicit prune protects every catalog ancestor and stops if current changes.

### Cloud-first operation (2026-09-24, user-approved replacement of local-only credentials)

The owner uses the smartphone ChatGPT app, never a PC or local `.env`.
[Publish replays](../../.github/workflows/publication.yml) is manual-only and uses a
successful main push CI/ci-gate SHA identical to the workflow source, rechecked after the
Environment boundary. PRs/forks cannot publish. Calculation/check/export has no production
secrets. Only allowlisted plan/index/objects pass by same-run immutable artifact ID.
Bucket-scoped keys live in Environment `r2-publication` (main-only deployment policy),
not repository-wide secrets, agent development environments, chat, source, logs or Pages.
Only the publication step receives them. No automatic publish, cleanup or plan upgrade.

`publication restore` recovers every retained generation on a fresh runner before export.
It requires a new directory, reuses graph/bundle/expanded-privacy verification, bounds reads,
and rechecks the R2 pointer; errors remove only its newly created incomplete directory.
The workflow caps restore downloads at 256MB and stops rather than silently expanding.
Workflow concurrency serializes writers; conditional PUT remains the cross-process guard.
The workflow requires complete calculations; existing CLI partial-row semantics stay intact.
User setup is browser-only; see [instructions](../development/cloud-publication.md).
Reader updates use authorized cloud tooling, not an owner-PC requirement.

R2 remains private. Reader serves only shared PublicKeySchema GET/HEAD/OPTIONS; no list,
write, signing or engine. JSON is application/json; gzip application/gzip without
Content-Encoding; no-transform, current max-age=30, immutable max-age=31536000.
CORS is exact Pages origin. Missing, damaged, unsupported, unavailable and visible
429/1027 limits have distinct viewer errors; CORS-hidden platform failures stay unavailable.

Cost baseline (2026-09-23): [R2](https://developers.cloudflare.com/r2/pricing/) Standard
free allowance 10GB-month, 1M Class A/10M Class B monthly, egress free;
[Workers](https://developers.cloudflare.com/workers/platform/pricing/) Free 100k/day
shared account-wide. These are allowances, not a guarantee of zero charges.
Keep publication <=8GB, inspect total account storage/requests and billing alerts before
routine operation. Stop publication on budget breach or quota errors; never silently upgrade.
Acceptance records must include actual account plan, retained bytes, upload/Worker requests,
public URL/build SHA, browser replay/CORS/compression and interruption/republication evidence.
Static tests alone do not establish external setup or production acceptance.
