"""One-shot, branch-scoped preparation; removed before source verification."""
from pathlib import Path
import json
import re
import sys

root = Path('.')

def write(path, text):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')

def replace(path, old, new):
    target = root / path
    text = target.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one replacement in {path}: {old[:100]!r}')
    target.write_text(text.replace(old, new), encoding='utf-8')

if sys.argv[1:] == ['finalize-sql']:
    files = list(Path('db/drizzle').glob('*.sql'))
    if len(files) != 1:
        raise RuntimeError('Expected precisely the generated initial Drizzle migration')
    sql = files[0].read_text(encoding='utf-8')
    if len(re.findall(r'CREATE TABLE ', sql)) != 3 or sql.count('\n);') != 3:
        raise RuntimeError('Review unexpected generated DDL before adopting existing tables')
    sql = sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
    sql = sql.replace('\n);', '\n) STRICT;')
    sql = sql.replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ')
    sql = '-- Initial adoption of the existing local-v1 tables without replacing their rows.\n-- STRICT is a reviewed SQLite extension not represented by Drizzle 0.45 snapshots.\n' + sql.rstrip() + '\n--> statement-breakpoint\nDROP TABLE IF EXISTS `schema_migrations`;\n--> statement-breakpoint\nDROP TABLE IF EXISTS `schema_generation`;\n'
    files[0].write_text(sql, encoding='utf-8')
    print(sql)
    sys.exit(0)
if sys.argv[1:] != ['source']:
    raise RuntimeError('Expected source or finalize-sql')

# Preserve the old DDL only as an input fixture, never as an executable migration path.
legacy = Path('db/migrations/001_initial.sql').read_text(encoding='utf-8')
write('apps/api/test-fixtures/local-v1.sql', legacy + '''\nCREATE TABLE schema_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL) STRICT;
INSERT INTO schema_generation VALUES (1, 'local-v1');
INSERT INTO schema_migrations VALUES ('001_initial.sql', 'legacy-test-receipt');
''')
for path in ['apps/api/src/migrations.ts', 'apps/api/src/migrations.test.ts',
             'apps/api/src/database-cli.ts', 'scripts/quality/migrations.ts',
             'scripts/quality/migrations.test.ts', 'db/schema.json',
             'db/migrations/001_initial.sql']:
    Path(path).unlink()

p = Path('package.json')
data = json.loads(p.read_text())
data['scripts'].update({
    'db:generate': 'node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs generate',
    'db:migrate': 'node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs migrate',
    'db:check': 'node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs check',
})
del data['scripts']['db:reset']
data['devDependencies'].update({'drizzle-kit': '0.31.11', 'drizzle-orm': '0.45.3', 'better-sqlite3': '13.0.3'})
write(str(p), json.dumps(data, indent=2) + '\n')
p = Path('apps/api/package.json')
data = json.loads(p.read_text())
for name in ['db:migrate', 'db:reset']:
    del data['scripts'][name]
data['scripts']['db:seed'] = 'node --env-file-if-exists=../../.env --import tsx src/seed.ts'
data['dependencies'].update({'drizzle-orm': '0.45.3', 'better-sqlite3': '13.0.3'})
data['devDependencies']['@types/better-sqlite3'] = '7.6.13'
write(str(p), json.dumps(data, indent=2) + '\n')

write('drizzle.config.ts', '''import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'drizzle-kit';

// All documented Kit commands run at the repository root. Existing environment
// variables take precedence over .env, just as they do for the API process.
if (existsSync('.env')) loadEnvFile('.env');
const filename = process.env.DATABASE_PATH ?? './data/fantasy.sqlite';
if (!filename.trim() || filename === ':memory:')
  throw new Error('Drizzle Kit requires a persistent DATABASE_PATH.');
const databasePath = resolve(filename);
mkdirSync(dirname(databasePath), { recursive: true });

export default defineConfig({
  dialect: 'sqlite',
  schema: resolve('apps/api/src/db/schema.ts'),
  out: resolve('db/drizzle'),
  dbCredentials: { url: databasePath },
});
''')
write('apps/api/src/db/schema.ts', '''import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// JSON remains text at the persistence boundary: the domain's Zod schemas
// validate it on both write and read. Never move domain contracts into this file.
export const characters = sqliteTable(
  'characters',
  {
    id: text('id').primaryKey().notNull(),
    definition: text('definition').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('characters_definition_json', sql`json_valid(${table.definition})`)],
);

export const rulesets = sqliteTable(
  'rulesets',
  {
    version: text('version').primaryKey().notNull(),
    definition: text('definition').notNull(),
  },
  (table) => [check('rulesets_definition_json', sql`json_valid(${table.definition})`)],
);

export const battles = sqliteTable(
  'battles',
  {
    id: text('id').primaryKey().notNull(),
    rulesVersion: text('rules_version').notNull().references(() => rulesets.version),
    recordJson: text('record_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('battles_record_json_valid', sql`json_valid(${table.recordJson})`),
    index('battles_created_at').on(sql`created_at desc`, sql`id desc`),
  ],
);
''')
write('apps/api/src/store.ts', '''import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  BattleRecordSchema,
  CharacterSchema,
  type BattleResult,
  type Character,
  type Ruleset,
} from '@fantasy/domain';
import { repositoryRoot } from './config.ts';
import { battles, characters, rulesets } from './db/schema.ts';

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Invalid JSON in database.');
  return JSON.parse(value) as unknown;
}

export function openStore(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  const db = drizzle(sqlite);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    // Official Drizzle migrator consumes the same Kit-generated SQL/journal and
    // __drizzle_migrations table as db:migrate. There is no application runner.
    migrate(db, { migrationsFolder: join(repositoryRoot, 'db/drizzle') });
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return {
    close: () => sqlite.close(),
    listCharacters: () =>
      db.select({ definition: characters.definition }).from(characters)
        .orderBy(asc(characters.id)).all()
        .map((row) => CharacterSchema.parse(jsonValue(row.definition))),
    getCharacter(id: string): Character | undefined {
      const row = db.select({ definition: characters.definition }).from(characters)
        .where(eq(characters.id, id)).get();
      return row ? CharacterSchema.parse(jsonValue(row.definition)) : undefined;
    },
    saveCharacter(input: Character) {
      const character = CharacterSchema.parse(input);
      const definition = JSON.stringify(character);
      const updatedAt = new Date().toISOString();
      db.insert(characters).values({ id: character.id, definition, updatedAt })
        .onConflictDoUpdate({ target: characters.id, set: { definition, updatedAt } }).run();
      return character;
    },
    seedCharacters(inputs: Character[]) {
      const validated = inputs.map((character) => CharacterSchema.parse(character));
      db.transaction((tx) => {
        for (const character of validated) {
          tx.insert(characters).values({
            id: character.id,
            definition: JSON.stringify(character),
            updatedAt: new Date().toISOString(),
          }).onConflictDoNothing({ target: characters.id }).run();
        }
      }, { behavior: 'immediate' });
    },
    registerRuleset(rules: Ruleset) {
      const definition = JSON.stringify(rules);
      db.insert(rulesets).values({ version: rules.version, definition })
        .onConflictDoNothing({ target: rulesets.version }).run();
      const saved = db.select({ definition: rulesets.definition }).from(rulesets)
        .where(eq(rulesets.version, rules.version)).get();
      if (saved?.definition !== definition) throw new Error('Rules changed without a version bump.');
    },
    saveBattle(participants: [Character, Character], result: BattleResult) {
      const record = BattleRecordSchema.parse({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        participants,
        result,
      });
      db.insert(battles).values({
        id: record.id,
        rulesVersion: result.rulesVersion,
        recordJson: JSON.stringify(record),
        createdAt: record.createdAt,
      }).run();
      return record;
    },
    listBattles: () =>
      db.select({ recordJson: battles.recordJson }).from(battles)
        .orderBy(desc(battles.createdAt), desc(battles.id)).limit(50).all()
        .map((row) => BattleRecordSchema.parse(jsonValue(row.recordJson))),
  };
}

export function readSampleCharacters(): Character[] {
  const directory = join(repositoryRoot, 'data/characters');
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    .map((name) => CharacterSchema.parse(jsonValue(readFileSync(join(directory, name), 'utf8'))));
}

export type Store = ReturnType<typeof openStore>;
''')
write('apps/api/src/seed.ts', '''import { DEFAULT_RULESET } from '@fantasy/engine';
import { readConfig } from './config.ts';
import { openStore, readSampleCharacters } from './store.ts';

if (process.argv.length !== 2) throw new Error('Usage: db:seed');
const config = readConfig();
const store = openStore(config.databasePath);
try {
  store.registerRuleset(DEFAULT_RULESET);
  store.seedCharacters(readSampleCharacters());
  console.log(`Missing sample characters inserted: ${config.databasePath}`);
} finally {
  store.close();
}
''')
replace('scripts/quality.ts', "import { execFileSync } from 'node:child_process';", "import { execFileSync, spawnSync } from 'node:child_process';\nimport { resolve } from 'node:path';")
replace('scripts/quality.ts', "import { checkMigrations } from './quality/migrations.ts';\n", '')
replace('scripts/quality.ts', "  await run('quality:migrations', () => checkMigrations(root));", '''  await run('quality:migrations', () => {
    const result = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'check'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, DATABASE_PATH: resolve(root, '.generated/drizzle-check.sqlite') },
    });
    if (result.error) throw result.error;
    return result.status === 0 ? [] : [{
      path: 'db/drizzle',
      reason: result.stderr || result.stdout || `Drizzle Kit exited ${String(result.status)}`,
      correction: 'Resolve the Drizzle Kit history conflict; never rewrite applied SQL.',
    }];
  });''')

write('apps/api/src/drizzle.test.ts', '''import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { BattleRecordSchema, CharacterSchema } from '@fantasy/domain';
import { DEFAULT_RULESET, simulateBattle } from '@fantasy/engine';
import { repositoryRoot } from './config.ts';
import { openStore, readSampleCharacters } from './store.ts';

const migrationsFolder = join(repositoryRoot, 'db/drizzle');
const kit = join(repositoryRoot, 'node_modules/drizzle-kit/bin.cjs');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'fantasy-drizzle-'));
  directories.push(directory);
  return directory;
}
function runKit(args: string[], filename: string) {
  const result = spawnSync(process.execPath, [kit, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, DATABASE_PATH: filename },
  });
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
function receipts(db: Database.Database) {
  return db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
}
function contents(directory: string) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(directory.length), readFileSync(path, 'utf8')];
    }).sort(([a], [b]) => String(a).localeCompare(String(b)));
}

describe('Drizzle Kit and ORM migration integration', () => {
  it('builds STRICT tables with JSON checks, foreign keys and the descending history index', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      migrate(drizzle(sqlite), { migrationsFolder });
      const tables = sqlite.prepare<[], { name: string; strict: number }>('PRAGMA table_list').all();
      for (const name of ['characters', 'rulesets', 'battles'])
        expect(tables.find((table) => table.name === name)?.strict).toBe(1);
      expect(tables.some((table) => ['schema_generation', 'schema_migrations'].includes(table.name))).toBe(false);
      expect(() => sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('invalid', '{', 'now')).toThrow();
      expect(() => sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run(null, '{}', 'now')).toThrow();
      expect(() => sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('blob', Buffer.from('{}'), 'now')).toThrow();
      expect(() => sqlite.prepare('INSERT INTO rulesets VALUES (?, ?)').run('invalid', '{')).toThrow();
      expect(() => sqlite.prepare('INSERT INTO battles VALUES (?, ?, ?, ?)').run('invalid', 'missing', '{}', 'now')).toThrow();
      sqlite.prepare('INSERT INTO rulesets VALUES (?, ?)').run('test', '{}');
      expect(() => sqlite.prepare('INSERT INTO battles VALUES (?, ?, ?, ?)').run('invalid', 'test', '{', 'now')).toThrow();
      const index = sqlite.prepare<[], { name: string | null; desc: number; key: number }>("PRAGMA index_xinfo('battles_created_at')").all();
      expect(index.filter((column) => column.key === 1).map(({ name, desc }) => ({ name, desc })))
        .toEqual([{ name: 'created_at', desc: 1 }, { name: 'id', desc: 1 }]);
      expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { sqlite.close(); }
  });

  it('shares the official history between Kit, startup and repeated execution', () => {
    const filename = join(temporary(), 'fresh.sqlite');
    runKit(['migrate'], filename);
    const first = new Database(filename);
    const before = receipts(first);
    first.close();
    expect(before.length).toBeGreaterThan(0);
    const store = openStore(filename);
    try { store.seedCharacters(readSampleCharacters()); } finally { store.close(); }
    runKit(['migrate'], filename);
    const second = new Database(filename);
    try {
      expect(receipts(second)).toEqual(before);
      expect(second.prepare('SELECT id FROM characters').all()).toHaveLength(2);
    } finally { second.close(); }
  }, 90000);

  it('adopts the real previous schema without changing edited characters, rules or battle snapshots', () => {
    const filename = join(temporary(), 'legacy.sqlite');
    const sqlite = new Database(filename);
    const left = CharacterSchema.parse(readSampleCharacters()[0]);
    const right = CharacterSchema.parse(readSampleCharacters()[1]);
    const edited = { ...left, name: '移行前の編集を保持' };
    const record = BattleRecordSchema.parse({
      id: '3d1c7b4a-01f7-4b3c-9c87-947e9dfc4fd2',
      createdAt: '2026-09-22T00:00:00.000Z',
      participants: [left, right],
      result: simulateBattle(left, right),
    });
    try {
      sqlite.exec(readFileSync(join(repositoryRoot, 'apps/api/test-fixtures/local-v1.sql'), 'utf8'));
      sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run(edited.id, JSON.stringify(edited), record.createdAt);
      sqlite.prepare('INSERT INTO rulesets VALUES (?, ?)').run(DEFAULT_RULESET.version, JSON.stringify(DEFAULT_RULESET));
      sqlite.prepare('INSERT INTO battles VALUES (?, ?, ?, ?)').run(record.id, DEFAULT_RULESET.version, JSON.stringify(record), record.createdAt);
    } finally { sqlite.close(); }
    runKit(['migrate'], filename);
    const store = openStore(filename);
    try {
      store.seedCharacters(readSampleCharacters());
      expect(store.getCharacter(edited.id)).toEqual(edited);
      expect(store.listBattles()).toEqual([record]);
      expect(() => store.registerRuleset(DEFAULT_RULESET)).not.toThrow();
      expect(() => store.registerRuleset({ ...DEFAULT_RULESET, maxRounds: 2 })).toThrow('version bump');
    } finally { store.close(); }
    const check = new Database(filename);
    try {
      expect(check.prepare('SELECT definition FROM characters WHERE id = ?').get(edited.id))
        .toEqual({ definition: JSON.stringify(edited) });
      expect(check.prepare("SELECT name FROM sqlite_schema WHERE name IN ('schema_generation', 'schema_migrations')").all()).toEqual([]);
      expect(check.pragma('foreign_key_check')).toEqual([]);
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { check.close(); }
  }, 90000);

  it('rolls back failed migration DDL and receipts using the official migrator', () => {
    const copy = join(temporary(), 'migrations');
    cpSync(migrationsFolder, copy, { recursive: true });
    const initial = readdirSync(copy).filter((name) => name.endsWith('.sql')).sort()[0];
    if (!initial) throw new Error('Missing generated migration');
    const file = join(copy, initial);
    writeFileSync(file, readFileSync(file, 'utf8') + '\\n--> statement-breakpoint\\nCREATE TABLE rollback_probe (id INTEGER);\\n--> statement-breakpoint\\nINSERT INTO deliberately_missing_table VALUES (1);\\n');
    const sqlite = new Database(':memory:');
    try {
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: copy })).toThrow();
      expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name IN ('characters', 'rulesets', 'battles', 'rollback_probe')").all()).toEqual([]);
      expect(receipts(sqlite)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('does not drop legacy receipts or data if adoption fails', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(readFileSync(join(repositoryRoot, 'apps/api/test-fixtures/local-v1.sql'), 'utf8'));
      sqlite.exec('DROP INDEX battles_created_at; ALTER TABLE battles RENAME COLUMN created_at TO unexpected_column;');
      sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('preserved', '{}', 'now');
      expect(() => migrate(drizzle(sqlite), { migrationsFolder })).toThrow();
      expect(sqlite.prepare('SELECT id FROM characters').all()).toEqual([{ id: 'preserved' }]);
      expect(sqlite.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_initial.sql' }]);
      expect(receipts(sqlite)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('keeps TypeScript schema and generated snapshots synchronized using Kit generate', () => {
    const directory = temporary();
    const output = join(directory, 'drizzle');
    cpSync(migrationsFolder, output, { recursive: true });
    const before = contents(output);
    const config = join(directory, 'drizzle.config.ts');
    writeFileSync(config, `export default ${JSON.stringify({
      dialect: 'sqlite',
      schema: resolve(repositoryRoot, 'apps/api/src/db/schema.ts'),
      out: output,
    })};\\n`);
    runKit(['generate', `--config=${config}`], join(directory, 'unused.sqlite'));
    expect(contents(output)).toEqual(before);
  }, 90000);

  it('keeps already committed Drizzle SQL and snapshots append-only with Git', () => {
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: repositoryRoot, encoding: 'utf8', timeout: 15000,
    });
    const base = process.env.MIGRATION_BASE_SHA || git(['merge-base', 'origin/main', 'HEAD']).trim();
    expect(base).toMatch(/^[a-f0-9]{40}$/);
    expect(git(['diff', '--name-only', '--diff-filter=MD', base, 'HEAD', '--',
      'db/drizzle/*.sql', 'db/drizzle/meta/*_snapshot.json']).trim()).toBe('');
  });
});
''')

replace('AGENTS.md', '- `db/migrations`: append-only, checksum-verified SQL migrations.', '- `apps/api/src/db/schema.ts`: Drizzle SQLite table definitions.\n- `db/drizzle`: Drizzle Kit SQL and snapshots; application startup uses the official Drizzle migrator. Never add a custom migration runner or history table.')
replace('AGENTS.md', '- Add a new numbered migration instead of editing an applied SQL file.', '- Run `vp run db:generate` after schema changes and commit the SQL plus snapshots. Use `vp run db:migrate` to apply; never use `push` in CI or rewrite an applied migration. Review SQLite `STRICT` on every table rebuild; see ADR 0004.')
write('docs/adr/0003-schema-generations.md', '''# Explicit SQLite schema generations (superseded)

Status: superseded by [ADR 0004](0004-drizzle-kit.md).

The user requested complete replacement of the application-owned migration system
with Drizzle Kit. The old runner, schema generation declaration, checksum receipts,
reset command and generation-specific verification have been removed. They must not
be reintroduced as a compatibility layer. The previous decision remains in Git history.
''')
write('docs/adr/0004-drizzle-kit.md', '''# Drizzle Kit owns schema evolution

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
''')
replace('README.md', 'SQLite / Node.js標準の`node:sqlite`', 'SQLite / Drizzle ORM / better-sqlite3')
replace('README.md', '| DB変更履歴       | SQLマイグレーション                 | `db/migrations`       |', '| DB変更履歴       | Drizzle Kit                        | `db/drizzle`          |')
replace('README.md', '''現在のDB世代は`db/schema.json`に宣言します。世代情報がない旧DBや別世代のDBは起動時に拒否します。
開発用には`vp run db:reset ./data/fantasy-new.sqlite --confirm-generation local-v1`で
新しいファイルを作り、`DATABASE_PATH`を切り替えてください。既存ファイルは置換しません。
[DB世代とresetの方針](docs/adr/0003-schema-generations.md)を参照してください。''', '''DBスキーマ・変更履歴はDrizzleへ統一しています。起動時はDrizzle公式migratorが未適用分を適用します。
従来の`local-v1`の既存テーブルとデータは初回のDrizzleマイグレーションで保持し、旧管理テーブルだけを削除します。
既存DBは先にバックアップし、APIを停止して`vp run db:migrate`で切り替えてください。
新しい開発用DBが必要なら`.env`の`DATABASE_PATH`を未使用のファイル名に変更してください。自動削除・reset機能はありません。
[Drizzle移行方針と制約](docs/adr/0004-drizzle-kit.md)を参照してください。''')
replace('README.md', '| `vp run db:migrate`                                        | SQLマイグレーションを適用                                    |', '| `vp run db:migrate`                                        | Drizzle Kitで未適用SQLを適用                                 |\n| `vp run db:generate`                                       | TypeScriptスキーマからDrizzleのSQL・snapshotを生成            |\n| `vp run db:check`                                          | Drizzle Kitの履歴整合性検査                                  |')
replace('README.md', '| `vp run db:reset <new-file> --confirm-generation local-v1` | 既存DBを残して新しい開発用DBを初期化                         |\n', '')
replace('README.md', 'APIは起動時にルートの`db/migrations`と`data/characters`を参照するため、リポジトリ内で実行してください。', 'APIは起動時にルートの`db/drizzle`と`data/characters`を参照するため、リポジトリ内で実行してください。')
replace('README.md', '''`db/migrations`に連番のSQLファイルを追加すると、起動時または`db:migrate`でトランザクション内に適用します。
適用済みSQLのチェックサムを保存しており、過去のファイルを書き換えると起動時に検出します。
SQL変更は既存ファイルの編集ではなく、新しいマイグレーションで行ってください。
Node.js 24の`node:sqlite`は実験的APIの警告が表示される場合があります。バージョンを固定して検証しています。''', '''`apps/api/src/db/schema.ts`を変更し、`vp run db:generate`で生成したSQLとsnapshotを`db/drizzle`へコミットします。
`vp run db:check`で履歴を検査し、SQLをレビューした上で`vp run db:migrate`を実行します。
API起動時も同じSQL・公式`__drizzle_migrations`履歴を使います。自前runner・世代管理・チェックサム台帳はありません。
既存SQLは書き換えず追記してください。CIはKit検査、生成差分、実DBへの適用・再実行・失敗rollback、Git上の履歴不変性を検証します。
Drizzleによる過去SQLの実行時改変検出は保証しません。レビュー済み履歴を迂回する`drizzle-kit push`は使用しません。
SQLiteの`STRICT`は生成SQLで維持する必要があります。テーブル再作成時も制約を確認してください。
JSONの実行時検証は引き続きZodが担い、キャラクター編集や過去の対戦記録を保持します。''')
print('Source migration prepared; next generate the lockfile and Drizzle snapshots with the pinned tools.')
