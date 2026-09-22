# Drizzle Kit owns schema evolution

Status: accepted by the user's complete-migration request, 2026-09-23.
Supersedes [ADR 0003](0003-schema-generations.md).

## Decision

Use pinned stable Drizzle ORM 0.45.3 and Drizzle Kit 0.31.11. The sole application
SQLite driver is better-sqlite3 13.0.3, replacing node:sqlite rather than introducing
an application adapter to a release-candidate driver. The CLI and API use the same
version, database path, generated SQL, snapshots and official __drizzle_migrations
history. Root tooling dependencies and API runtime dependencies share lockfile entries.
The application remains local-only; no hosting or Cloudflare resources are changed.

`apps/api/src/db/schema.ts` is the relational schema source. `db/drizzle` contains
Kit-generated SQL and metadata. `db:generate`, `db:migrate` and `db:check` invoke the
actual Kit CLI. Startup and in-memory integration tests invoke the official
`drizzle-orm/better-sqlite3/migrator` directly, not an application runner. The official
migrator and Kit consume the same history; their interoperability is integration-tested.
Store queries and seed transactions use Drizzle ORM; Zod remains responsible for
runtime domain/JSON validation. Battle rules and engine implementation are unchanged.
Dependency/lockfile changes do change the reviewed engine identity digest.

## Existing database adoption

The first generated migration is explicitly reviewed before initial release: its
CREATE TABLE/INDEX statements use IF NOT EXISTS so the existing local-v1 tables and
all their rows are adopted without resets or recreations. The old schema_generation
and schema_migrations tables are dropped in that same official migration transaction.
No code reads, translates, validates or maintains old receipts, and no custom history
is written. New databases take the very same path. Known legacy schema adoption,
edited characters, immutable rules, battle snapshots and reexecution are tested.

Back up an existing database and stop the API before the first explicit `db:migrate`.
This adoption supports the repository's existing local-v1 DDL, not arbitrary SQLite
schemas. A failed migration must be investigated, not bypassed with reset or push.
There is no generation guessing, automatic file deletion, bespoke reset command,
down runner, SQL splitter, checksum store or parallel migration implementation.
For disposable development, select a new DATABASE_PATH and run the normal migration.
Run schema-changing commands serially; no custom distributed migration lock is added.

## SQLite details and verification

Preserve STRICT tables, NOT NULL keys, JSON validity checks, foreign keys and the
descending history index. Stable Drizzle snapshots do not represent SQLite STRICT;
the initial generated SQL therefore includes a reviewed STRICT amendment. Review and
retain it whenever future generated SQL rebuilds a table. This is migration SQL,
not a custom execution engine. Do not substitute `drizzle-kit push`, which would
bypass the reviewed migration SQL. Unsupported DDL belongs in Kit custom migrations.

`quality:migrations` now invokes `drizzle-kit check`. Integration tests cover fresh
creation, Kit/ORM history interoperability, old data adoption, failure rollback,
constraints and snapshot/schema synchronization using Kit generate in a temporary
folder. A Git diff test keeps committed Drizzle SQL/snapshots append-only; it does not
parse or execute SQL. All database tests use disposable paths or in-memory databases.
Both OS jobs still run the canonical source evidence harness and all existing gates.

Drizzle's history is not a replacement for the removed runtime checksum/generation
validator. Do not claim runtime detection of modified old migrations or arbitrary
schema drift. Immutability is enforced in reviewed Git/CI changes, while Kit checks
history consistency and real database tests verify the supported schema/data paths.

## References

- https://orm.drizzle.team/docs/drizzle-kit-generate
- https://orm.drizzle.team/docs/drizzle-kit-migrate
- https://orm.drizzle.team/docs/sqlite/kit-custom-migrations
- https://orm.drizzle.team/docs/get-started/sqlite-new
