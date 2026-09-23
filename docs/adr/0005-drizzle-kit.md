# Drizzle Kit owns schema evolution

Status: accepted by the user's complete migration request, 2026-09-23.
Supersedes ADR 0003 and the migration/reset portions of ADR 0004, not its 3D model.

## Decision

Pin stable Drizzle ORM 0.45.3, Kit 0.31.11 and better-sqlite3 13.0.3.
Replace node:sqlite instead of adding a bespoke adapter to an RC driver. Kit CLI,
API startup and tests share the generated SQL/journal and __drizzle_migrations.
The application directly invokes the official ORM migrator. No application runner,
SQL splitter, generation validator, checksum ledger, custom reset, down executor
or parallel migration implementation remains. Store queries and short synchronous
transactions use Drizzle ORM. Zod still validates domain JSON and published inputs.
Runtime library/driver versions are shared with root tooling in the real lockfile.

## Concurrent main and existing database adoption

The task began against local-v1. While implementing it, main d7dc7ed introduced
spatial revisions, drafts and immutable BattleSpecs, removing the legacy engine/API.
Integrate that work without resurrecting old contracts. The initial, unreleased
Drizzle baseline is generated for these current three tables, not the old tables.
Within the same battle-rules version, databases with former migrations 002 and 003 applied are adopted
using reviewed IF NOT EXISTS DDL. Their revisions, draft versions/bases, JSON and
specifications remain unchanged. The official transaction removes only the old
schema_generation and schema_migrations bookkeeping tables. No legacy receipts are
read, translated or maintained. Arbitrary partial/ad-hoc schemas are not supported.

Issue #59 changes version transitions: defaults are now
`data/<CURRENT_ENGINE_VERSION>/fantasy.sqlite` and `data/<CURRENT_ENGINE_VERSION>/replays`
(currently `spatial-v1.11`). Leave both environment overrides unset to follow version bumps.
Before opening SQLite, inspect stored ruleset `rulesVersion` and BattleSpec `engineVersion`.
All observed versions must be current. Missing, unreadable or mixed evidence is refused,
including existing schema-only files. A temporary private copy includes WAL data so SQLite
cannot modify the original DB/WAL/SHM during admission. This copy is only inspected and
removed; it is never migrated, seeded or imported into the application database.
Artifact admission runs before opening the configured DB and retains `.store-id` ownership.
Errors show the stored/current versions and how to select two unused paths.

Back up a same-version database and stop the API before `db:migrate`. New installations
use `dev` or `db:seed`, which run the official migration and seed together. A crash leaving
no version evidence requires another unused path; do not guess or adopt it automatically.
Old-version DBs, drafts and artifacts are left untouched and absent from new-app lists.
Exported/static replay records may be displayed under supported replay schemas; old engines
and database imports are not added. To discard an old version, stop its API, preserve any
needed backup/export and manually remove only its old directory (OS examples in README).
No reset, schema-generation declaration, checksum receipt, history table or custom migrator is added.
Run schema changes serially. This does not add a custom distributed migration lock.

## Generation and verification

The relational source is apps/api/src/db/schema.ts. Kit generate writes SQL/snapshots
to db/drizzle; Kit check verifies history. Use a relative out path: Kit 0.31 snapshot
validation prefixes paths with ./, so absolute out paths fail on subsequent runs.
Tests verify actual successful no-change output, not exit 0 alone, because some Kit
generation errors exit 0. Temporary generation tests use their own cwd and relative
output, including across Windows drive boundaries. Never replace reviewed SQL with push.

Stable snapshots do not represent STRICT or immutable triggers. Review those SQL
amendments explicitly and preserve them on table rebuilds. Fresh/current-schema
adoption, CLI/startup interoperability, incremental upgrades, rollback, constraints,
trigger immutability, revision paging, optimistic publication across connections and
saved specifications are real integration tests. Git checks keep committed Drizzle
SQL/snapshots append-only; they neither parse nor execute SQL. The existing source
harness and both-platform CI remain canonical and unweakened.

Removed runtime checksum/generation guarantees are not claimed as Drizzle features.
Git review/CI guard source immutability; domain revision hashes and optimistic draft
versions retain their distinct business purpose. Engine identity is explicitly
restamped for reviewed toolchain/input changes, not to hide simulation regressions.

References:

- https://orm.drizzle.team/docs/drizzle-kit-generate
- https://orm.drizzle.team/docs/drizzle-kit-migrate
- https://orm.drizzle.team/docs/sqlite/kit-custom-migrations
