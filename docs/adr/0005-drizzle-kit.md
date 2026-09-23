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
Existing spatial-v1 databases with former migrations 002 and 003 applied are adopted
using reviewed IF NOT EXISTS DDL. Their revisions, draft versions/bases, JSON and
specifications remain unchanged. The official transaction removes only the old
schema_generation and schema_migrations bookkeeping tables. No legacy receipts are
read, translated or maintained. Arbitrary partial/ad-hoc schemas are not supported.

Back up an existing SQLite database and stop the API before the first db:migrate.
Old local-v1 domain rows are not converted to 3D definitions or exposed by a legacy
API; unrelated tables/rows are not deleted. A new disposable database can be selected
with DATABASE_PATH. No reset, automatic deletion or broad schema inference is added.
Run schema changes serially. This does not add a custom distributed migration lock.

For later battle-version changes, [ADR 0010](0010-battle-version-compatibility.md)
preserves readable definitions/results/replays in the same database through additive
schemas and new rules/sample IDs. A rules-version bump alone does not select a new
database or reject the old one. An unavoidable incompatible change needs its own
reviewed ADR before implementing separate DB/artifact paths and explicit-path rejection.
Previous-version fixtures, unsupported-job handling and catalog-history checks remain
implementation work under Issue #59; this decision does not claim they already pass.

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
