# Drizzle Kit owns schema evolution

Status: accepted by the user's complete migration request, 2026-09-23.
Supersedes ADR 0003 and migration/reset in ADR 0004, not its 3D model.
[Adoption history](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0005-drizzle-kit.md)
retains the concurrent-main decision and original verification record.

## Current contract

Pin Drizzle ORM 0.45.3, Kit 0.31.11 and better-sqlite3 13.0.3 in the shared lockfile.
Kit CLI and API startup use the same generated SQL/journal and __drizzle_migrations;
the application calls the official ORM migrator. Drizzle owns queries and short
synchronous transactions; Zod validates domain JSON. No custom runner, SQL splitter,
checksum/generation ledger, reset/down executor or RC-driver adapter is supported.

Back up SQLite and stop the API before first db:migrate; serialize schema changes.
There is no distributed migration lock. Reviewed IF NOT EXISTS DDL adopts existing
spatial-v1 databases with former migrations 002/003, preserving revisions, drafts
and BattleSpecs. The official transaction removes only old schema_generation and
schema_migrations bookkeeping. It does not translate receipts, infer arbitrary
partial schemas, convert local-v1 rows or delete unrelated tables. Use DATABASE_PATH
for a fresh disposable database; no automatic reset is provided.

[ADR 0010](0010-battle-version-compatibility.md) governs later version changes:
keep saved definitions/results/replays readable through additive schemas and new
rules/sample IDs. A rules bump alone never selects a new database. Incompatible
DB/artifact separation or explicit-path rejection needs a reviewed ADR.

## Generation and verification

apps/api/src/db/schema.ts is the source; Kit generate/check owns db/drizzle SQL,
snapshots and history. Use a relative out path and isolated cwd: Kit 0.31 prefixes
snapshot paths with ./ and some errors exit 0. Assert actual no-change output,
including temporary generation across drive boundaries; never substitute push.
STRICT and immutable triggers need explicit SQL review and preservation on rebuilds.

Real integration tests cover adoption, CLI/startup reexecution, upgrades/rollback,
constraints/triggers, revision paging, concurrent optimistic publication and saved
specifications. Append-only Git checks protect committed SQL/snapshots; they do not
parse/execute migrations or promise runtime drift detection. Revision hashes and
draft versions retain their business purpose. Current Linux source/CI verification
remains canonical. Restamps require reviewed input changes, never hidden regressions.

References: [generate](https://orm.drizzle.team/docs/drizzle-kit-generate),
[migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate),
[custom SQL](https://orm.drizzle.team/docs/sqlite/kit-custom-migrations).
