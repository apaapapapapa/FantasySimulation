from pathlib import Path
import json
import re
import shutil
import subprocess
import sys

MAIN = 'd7dc7edfa36ce8ddb45e8d2a66a434952c9463ae'

def read_main(path):
    return subprocess.check_output(['git', 'show', f'{MAIN}:{path}'], text=True)

def write(path, text):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one occurrence: {old[:100]!r}')
    return text.replace(old, new)

def block(text, start, end, replacement):
    if text.count(start) != 1 or text.count(end) != 1:
        raise RuntimeError(f'Ambiguous method bounds: {start} / {end}')
    left, right = text.index(start), text.index(end)
    assert right > left
    return text[:left] + replacement + text[right:]

if sys.argv[1:] == ['sql']:
    files = list(Path('db/drizzle').glob('*.sql'))
    assert len(files) == 1
    text = files[0].read_text()
    assert text.count('CREATE TABLE ') == 3 and text.count('\n);') == 3
    text = text.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ').replace('\n);', '\n) STRICT;')
    triggers = re.findall(r'CREATE TRIGGER .*?\nEND;', read_main('db/migrations/002_spatial_revisions.sql'), re.S)
    assert len(triggers) == 4
    for trigger in triggers:
        text += '\n--> statement-breakpoint\n' + trigger.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ') + '\n'
    text += '\n--> statement-breakpoint\nDROP TABLE IF EXISTS schema_migrations;\n--> statement-breakpoint\nDROP TABLE IF EXISTS schema_generation;\n'
    text = '-- Adopt the existing spatial-v1 (002 + 003) schema without replacing its rows.\n-- STRICT and immutable triggers are reviewed SQLite additions to Kit-generated SQL.\n' + text
    write(str(files[0]), text)
    print(text)
    sys.exit(0)
assert sys.argv[1:] == ['source']

# Preserve all of the concurrently published domain/API changes before replacing
# only their persistence boundary. The old local-v1 engine is not resurrected.
package = json.loads(read_main('package.json'))
package['scripts'].update({
    'db:generate': 'node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs generate',
    'db:migrate': 'node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs migrate',
    'db:check': 'node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs check',
})
package['scripts'].pop('db:reset', None)
package['devDependencies'].update({'drizzle-kit': '0.31.11', 'drizzle-orm': '0.45.3', 'better-sqlite3': '13.0.3'})
write('package.json', json.dumps(package, indent=2) + '\n')

fixture = read_main('db/migrations/002_spatial_revisions.sql') + '\n' + read_main('db/migrations/003_draft_base.sql')
fixture += '''\nCREATE TABLE schema_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL) STRICT;
INSERT INTO schema_generation VALUES (1, 'spatial-v1');
INSERT INTO schema_migrations VALUES ('002_spatial_revisions.sql', 'fixture-002');
INSERT INTO schema_migrations VALUES ('003_draft_base.sql', 'fixture-003');
'''
write('apps/api/test-fixtures/spatial-v1.sql', fixture)
for path in ['apps/api/test-fixtures/local-v1.sql', 'apps/api/src/migrations.ts', 'apps/api/src/migrations.test.ts',
             'apps/api/src/database-cli.ts', 'scripts/quality/migrations.ts', 'scripts/quality/migrations.test.ts', 'db/schema.json']:
    Path(path).unlink(missing_ok=True)
for path in ['db/migrations', 'db/drizzle']:
    if Path(path).exists(): shutil.rmtree(path)

write('apps/api/src/db/schema.ts', '''import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const kinds = ['character', 'ability', 'equipment', 'policy', 'status', 'ruleset', 'scenario'] as const;

export const publishedRevisions = sqliteTable('published_revisions', {
  kind: text('kind', { enum: kinds }).notNull(),
  definitionId: text('definition_id').notNull(),
  revision: integer('revision').notNull(),
  contentHash: text('content_hash').notNull(),
  revisionJson: text('revision_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.kind, table.definitionId, table.revision] }),
  check('published_revisions_kind', sql`${table.kind} IN ('character','ability','equipment','policy','status','ruleset','scenario')`),
  check('published_revisions_positive_revision', sql`${table.revision} > 0`),
  check('published_revisions_valid_json', sql`json_valid(${table.revisionJson})`),
]);

export const definitionDrafts = sqliteTable('definition_drafts', {
  id: text('id').primaryKey().notNull(),
  kind: text('kind', { enum: kinds }).notNull(),
  definitionId: text('definition_id').notNull(),
  version: integer('version').notNull(),
  definitionJson: text('definition_json').notNull(),
  publishedJson: text('published_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  baseRevisionJson: text('base_revision_json'),
}, (table) => [
  check('definition_drafts_kind', sql`${table.kind} IN ('character','ability','equipment','policy','status','ruleset','scenario')`),
  check('definition_drafts_positive_version', sql`${table.version} > 0`),
  check('definition_drafts_valid_json', sql`json_valid(${table.definitionJson})`),
  check('definition_drafts_valid_published', sql`${table.publishedJson} IS NULL OR json_valid(${table.publishedJson})`),
  check('definition_drafts_valid_base', sql`${table.baseRevisionJson} IS NULL OR json_valid(${table.baseRevisionJson})`),
]);

export const battleSpecs = sqliteTable('battle_specs', {
  simulationHash: text('simulation_hash').primaryKey().notNull(),
  manifestJson: text('manifest_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [check('battle_specs_valid_json', sql`json_valid(${table.manifestJson})`)]);
''')

store = read_main('apps/api/src/store.ts')
store = replace_once(store, "import { DatabaseSync } from 'node:sqlite';", "import Database from 'better-sqlite3';\nimport { and, asc, desc, eq, gt, lt, max, sql } from 'drizzle-orm';\nimport { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';\nimport { migrate } from 'drizzle-orm/better-sqlite3/migrator';\nimport { alias } from 'drizzle-orm/sqlite-core';\nimport { battleSpecs, definitionDrafts, publishedRevisions } from './db/schema.ts';")
store = replace_once(store, "import { migrate } from './migrations.ts';\n", '')
store = block(store, '  readonly db: DatabaseSync;', '  getRevision(', '''  readonly db: Database.Database;
  private readonly orm: BetterSQLite3Database;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.orm = drizzle(this.db);
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      // The official migrator and Kit share the same SQL, journal and receipts.
      migrate(this.orm, { migrationsFolder: join(repositoryRoot, 'db/drizzle') });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    return this.orm.transaction(() => {
      const value = work();
      if (value instanceof Promise) throw new Error('Database transactions cannot await');
      return value;
    }, { behavior: 'immediate' });
  }
''')
store = block(store, '  getRevision(', '  requireRevision(', '''  getRevision(kind: DefinitionKind, id: string, revision?: number): Revision | undefined {
    const row = this.orm.select({ revisionJson: publishedRevisions.revisionJson })
      .from(publishedRevisions)
      .where(and(eq(publishedRevisions.kind, kind), eq(publishedRevisions.definitionId, id),
        revision === undefined ? undefined : eq(publishedRevisions.revision, revision)))
      .orderBy(desc(publishedRevisions.revision)).limit(1).get();
    return row ? parseJson(RevisionSchema, jsonValue(row.revisionJson)) : undefined;
  }
''')
store = block(store, '  listRevisions(', '  async seedRevisions(', '''  listRevisions(kind: DefinitionKind, limit = 50, cursor = '') {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new StoreError(400, 'Page size must be 1..100');
    const latest = alias(publishedRevisions, 'latest');
    const last = this.orm.select({ value: max(latest.revision) }).from(latest)
      .where(and(eq(latest.kind, publishedRevisions.kind), eq(latest.definitionId, publishedRevisions.definitionId)));
    const rows = this.orm.select({ revisionJson: publishedRevisions.revisionJson }).from(publishedRevisions)
      .where(and(eq(publishedRevisions.kind, kind), gt(publishedRevisions.definitionId, cursor), eq(publishedRevisions.revision, last)))
      .orderBy(asc(publishedRevisions.definitionId)).limit(limit + 1).all();
    const items = rows.slice(0, limit).map((row) => parseJson(RevisionSchema, jsonValue(row.revisionJson)));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }
  private insertRevision(revision: Revision, now: string) {
    this.orm.insert(publishedRevisions).values({
      kind: revision.kind, definitionId: revision.id, revision: revision.revision,
      contentHash: revision.contentHash, revisionJson: canonicalJson(revision), createdAt: now,
    }).run();
  }
''')
store = block(store, '  createDraft(', '  private checkDraftBase(', '''  createDraft(input: unknown): Draft {
    const draft = parseJson(DraftInputSchema, input), id = randomUUID(), now = new Date().toISOString();
    return this.transaction(() => {
      this.checkDraftBase(draft);
      this.orm.insert(definitionDrafts).values({
        id, kind: draft.kind, definitionId: draft.definitionId, version: 1,
        definitionJson: canonicalJson(draft.definition), publishedJson: null,
        createdAt: now, updatedAt: now,
        baseRevisionJson: draft.base === null ? null : canonicalJson(draft.base),
      }).run();
      return this.getDraft(id)!;
    });
  }
''')
store = block(store, '  getDraft(', '  private async candidate(', '''  getDraft(id: string): Draft | undefined {
    const row = this.orm.select().from(definitionDrafts).where(eq(definitionDrafts.id, id)).get();
    return row ? parseJson(DraftSchema, {
      id: row.id, kind: row.kind, definitionId: row.definitionId,
      base: row.baseRevisionJson === null ? null : jsonValue(row.baseRevisionJson),
      version: row.version, definition: jsonValue(row.definitionJson),
      published: row.publishedJson === null ? null : jsonValue(row.publishedJson),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }) : undefined;
  }
  patchDraft(id: string, expectedVersion: number, definition: unknown): Draft {
    const encoded = canonicalJson(definition);
    const result = this.orm.update(definitionDrafts).set({
      definitionJson: encoded, version: sql`${definitionDrafts.version} + 1`, updatedAt: new Date().toISOString(),
    }).where(and(eq(definitionDrafts.id, id), eq(definitionDrafts.version, expectedVersion), lt(definitionDrafts.version, 2147483647))).run();
    if (!result.changes)
      throw new StoreError(this.getDraft(id) ? 409 : 404, 'Draft missing or changed; reload before editing');
    return this.getDraft(id)!;
  }
''')
old_start = "      this.db\n        .prepare(\n          'UPDATE definition_drafts SET version=version+1,published_json=?"
left = store.index(old_start)
right = store.index('      return { draft: this.getDraft(id)!, revision };', left)
store = store[:left] + '''      this.orm.update(definitionDrafts).set({
        version: sql`${definitionDrafts.version} + 1`,
        publishedJson: canonicalJson(reference(revision)),
        baseRevisionJson: canonicalJson(reference(revision)), updatedAt: now,
      }).where(and(eq(definitionDrafts.id, id), eq(definitionDrafts.version, expectedVersion), lt(definitionDrafts.version, 2147483647))).run();
''' + store[right:]
store = block(store, '  saveSpec(', '\n}\nexport const openStore', '''  saveSpec(battle: PreparedBattle) {
    const encoded = canonicalJson(battle.manifest);
    this.orm.insert(battleSpecs).values({ simulationHash: battle.simulationHash,
      manifestJson: encoded, createdAt: new Date().toISOString(),
    }).onConflictDoNothing({ target: battleSpecs.simulationHash }).run();
    const row = this.orm.select({ manifestJson: battleSpecs.manifestJson }).from(battleSpecs)
      .where(eq(battleSpecs.simulationHash, battle.simulationHash)).get();
    if (row?.manifestJson !== encoded) throw new Error('Battle specification hash collision');
    return { simulationHash: battle.simulationHash, manifest: battle.manifest };
  }
  getSpec(simulationHash: string) {
    const row = this.orm.select({ manifestJson: battleSpecs.manifestJson }).from(battleSpecs)
      .where(eq(battleSpecs.simulationHash, simulationHash)).get();
    return row ? { simulationHash, manifest: parseJson(ManifestSchema, jsonValue(row.manifestJson)) } : undefined;
  }''')
assert '.prepare(' not in store and "'node:sqlite'" not in store and "'./migrations.ts'" not in store
write('apps/api/src/store.ts', store)
write('apps/api/src/seed.ts', '''import { readConfig } from './config.ts';
import { openStore, readSampleRevisions } from './store.ts';

if (process.argv.length !== 2) throw new Error('Usage: db:seed');
const config = readConfig();
const store = openStore(config.databasePath);
try {
  await store.seedRevisions(readSampleRevisions());
  console.log(`Missing sample revisions inserted: ${config.databasePath}`);
} finally {
  store.close();
}
''')
app = read_main('apps/api/src/app.ts').replace("    schemaGeneration: 'spatial-v1',", "    migrationTool: 'drizzle',")
write('apps/api/src/app.ts', app)
tests = read_main('apps/api/src/app.test.ts')
tests = tests.replace("import { DatabaseSync } from 'node:sqlite';", "import Database from 'better-sqlite3';")
tests = tests.replace("schemaGeneration: 'spatial-v1'", "migrationTool: 'drizzle'").replace('new DatabaseSync(', 'new Database(')
tests = tests.replace("describe('3D revision API and new SQLite generation'", "describe('3D revision API and Drizzle persistence'")
tests = tests.replace("it('initializes only the new tables and refuses another generation without destroying it'", "it('initializes only current tables and preserves unrelated legacy data'")
tests = replace_once(tests, "    expect(() => openStore(filename)).toThrow(/Unsupported database/);", "    const adopted = openStore(filename);\n    adopted.close();")
tests = tests.replace(".prepare('SELECT COUNT(*) AS n FROM battle_specs')", ".prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM battle_specs')")
tests = tests.replace(".prepare('SELECT COUNT(*) AS n FROM definition_drafts')", ".prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM definition_drafts')")
tests = tests.replace(".prepare('SELECT value FROM valuable')", ".prepare<[], { value: string }>('SELECT value FROM valuable')")
write('apps/api/src/app.test.ts', tests)

# The initial unreleased Drizzle baseline is regenerated for the now-current
# spatial schema. No released/applied Drizzle SQL exists on main.
old_test = Path('apps/api/src/drizzle.test.ts').read_text()
helpers = old_test[:old_test.index("describe('Drizzle Kit")]
helpers = helpers.replace("import { BattleRecordSchema, CharacterSchema } from '@fantasy/domain';", "import { canonicalJson, RevisionSchema } from '@fantasy/domain/spatial';")
helpers = helpers.replace("import { DEFAULT_RULESET, simulateBattle } from '@fantasy/engine';", "import { catalogManifest, prepareBattle, reference } from '@fantasy/engine/spatial';")
helpers = helpers.replace('openStore, readSampleCharacters', 'openStore, readSampleRevisions')
keep_start = old_test.index("  it('applies a Kit-generated incremental migration")
tail = old_test[keep_start:]
tail = tail.replace("sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('existing', '{}', 'before');", "sqlite.prepare('INSERT INTO battle_specs VALUES (?, ?, ?)').run('existing', '{}', 'before');")
tail = tail.replace('ALTER TABLE characters ADD COLUMN migration_probe TEXT;', 'ALTER TABLE definition_drafts ADD COLUMN migration_probe TEXT;')
tail = tail.replace("sqlite.prepare('SELECT id, definition, updated_at, migration_probe FROM characters').all()", "sqlite.prepare('SELECT simulation_hash, manifest_json, created_at FROM battle_specs').all()")
tail = tail.replace("{ id: 'existing', definition: '{}', updated_at: 'before', migration_probe: null }", "{ simulation_hash: 'existing', manifest_json: '{}', created_at: 'before' }")
# Assert the incremental column really exists, in addition to receipt progression.
tail = tail.replace('      const after = receipts(sqlite);', "      expect(sqlite.prepare('SELECT migration_probe FROM definition_drafts').all()).toEqual([]);\n      const after = receipts(sqlite);")
head = '''const legacyFixture = () => readFileSync(join(repositoryRoot, 'apps/api/test-fixtures/spatial-v1.sql'), 'utf8');
function failingMigrations() {
  const copy = join(temporary(), 'migrations');
  cpSync(migrationsFolder, copy, { recursive: true });
  const initial = readdirSync(copy).filter((name) => name.endsWith('.sql')).sort()[0];
  if (!initial) throw new Error('Missing generated migration');
  const path = join(copy, initial);
  writeFileSync(path, readFileSync(path, 'utf8') + '\\n--> statement-breakpoint\\nCREATE TABLE rollback_probe(id INTEGER);\\n--> statement-breakpoint\\nINSERT INTO deliberately_missing_table VALUES(1);\\n');
  return copy;
}

describe('Drizzle Kit and spatial persistence integration', () => {
  it('builds STRICT tables, JSON and kind checks, composite keys and immutable triggers', () => {
    const db = new Database(':memory:');
    try {
      migrate(drizzle(db), { migrationsFolder });
      const tables = db.prepare<[], { name: string; strict: number }>('PRAGMA table_list').all();
      for (const name of ['published_revisions', 'definition_drafts', 'battle_specs'])
        expect(tables.find((table) => table.name === name)?.strict).toBe(1);
      expect(tables.some((table) => ['schema_generation', 'schema_migrations', 'characters', 'rulesets', 'battles'].includes(table.name))).toBe(false);
      const insert = db.prepare('INSERT INTO published_revisions VALUES(?,?,?,?,?,?)');
      expect(() => insert.run('invalid', 'id', 1, 'hash', '{}', 'now')).toThrow(/CHECK constraint failed/);
      expect(() => insert.run('policy', 'id', 0, 'hash', '{}', 'now')).toThrow(/CHECK constraint failed/);
      expect(() => insert.run('policy', 'id', 1, 'hash', '{', 'now')).toThrow(/CHECK constraint failed/);
      expect(() => insert.run('policy', null, 1, 'hash', '{}', 'now')).toThrow(/NOT NULL constraint failed/);
      expect(() => insert.run('policy', 'id', 1, 'hash', Buffer.from('{}'), 'now')).toThrow(/cannot store BLOB value in TEXT column/);
      insert.run('policy', 'id', 1, 'hash', '{}', 'now');
      expect(() => insert.run('policy', 'id', 1, 'hash', '{}', 'now')).toThrow(/UNIQUE constraint failed/);
      expect(() => db.prepare('UPDATE published_revisions SET revision=2').run()).toThrow(/immutable/);
      expect(() => db.prepare('DELETE FROM published_revisions').run()).toThrow(/cannot be deleted/);
      expect(() => db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run(null, '{}', 'now')).toThrow(/NOT NULL constraint failed/);
      expect(() => db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('hash', '{', 'now')).toThrow(/CHECK constraint failed/);
      db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('hash', '{}', 'now');
      expect(() => db.prepare("UPDATE battle_specs SET manifest_json='{}'").run()).toThrow(/immutable/);
      expect(() => db.prepare('DELETE FROM battle_specs').run()).toThrow(/cannot be deleted/);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()).toHaveLength(4);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { db.close(); }
  });

  it('shares official history between Kit, startup and repeated execution', async () => {
    const filename = join(temporary(), 'fresh.sqlite');
    runKit(['migrate'], filename);
    const first = new Database(filename);
    const before = receipts(first);
    first.close();
    expect(before.length).toBeGreaterThan(0);
    const store = openStore(filename);
    try {
      await store.seedRevisions(readSampleRevisions());
      expect(store.listRevisions('character').items).toHaveLength(10);
    } finally { store.close(); }
    runKit(['migrate'], filename);
    const second = new Database(filename);
    try { expect(receipts(second)).toEqual(before); } finally { second.close(); }
  }, 90000);

  it('adopts existing spatial revisions, edited drafts and immutable specifications without changing rows', async () => {
    const filename = join(temporary(), 'legacy.sqlite');
    const db = new Database(filename);
    const revisions = readSampleRevisions().map((r) => RevisionSchema.parse(r));
    const character = revisions.find((r) => r.kind === 'character' && r.id === 'swordsman');
    if (!character) throw new Error('Missing sample character');
    const battle = await prepareBattle(await catalogManifest());
    const definition = { ...character.definition, name: '移行前の編集を保持' };
    const id = '3d1c7b4a-01f7-4b3c-9c87-947e9dfc4fd2';
    const now = '2026-09-22T00:00:00.000Z';
    try {
      db.exec(legacyFixture());
      for (const r of revisions)
        db.prepare('INSERT INTO published_revisions VALUES(?,?,?,?,?,?)').run(r.kind, r.id, r.revision, r.contentHash, canonicalJson(r), now);
      db.prepare('INSERT INTO definition_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(id, character.kind, character.id, 3, canonicalJson(definition), null, now, now, canonicalJson(reference(character)));
      db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run(battle.simulationHash, canonicalJson(battle.manifest), now);
    } finally { db.close(); }
    runKit(['migrate'], filename);
    const store = openStore(filename);
    try {
      await store.seedRevisions(readSampleRevisions());
      expect(store.getRevision('character', character.id, character.revision)).toEqual(character);
      expect(store.getDraft(id)).toMatchObject({ id, definition, base: reference(character), version: 3, published: null });
      expect(store.getSpec(battle.simulationHash)).toEqual({ simulationHash: battle.simulationHash, manifest: battle.manifest });
      expect(store.db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('schema_generation','schema_migrations')").all()).toEqual([]);
      expect(store.db.prepare('SELECT revision_json FROM published_revisions WHERE kind=? AND definition_id=? AND revision=?').get(character.kind, character.id, character.revision)).toEqual({ revision_json: canonicalJson(character) });
      expect(store.db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { store.close(); }
  }, 90000);

  it('rolls back failed initial migration DDL and official receipts', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migrate(drizzle(db), { migrationsFolder: failingMigrations() })).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('published_revisions','definition_drafts','battle_specs','rollback_probe')").all()).toEqual([]);
      expect(receipts(db)).toEqual([]);
    } finally { db.close(); }
  });

  it('restores existing data and old receipts if the adoption transaction fails', () => {
    const db = new Database(':memory:');
    try {
      db.exec(legacyFixture());
      db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('keep', '{}', 'before');
      expect(() => migrate(drizzle(db), { migrationsFolder: failingMigrations() })).toThrow();
      expect(db.prepare('SELECT simulation_hash FROM battle_specs').all()).toEqual([{ simulation_hash: 'keep' }]);
      expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()).toEqual([{ name: '002_spatial_revisions.sql' }, { name: '003_draft_base.sql' }]);
      expect(receipts(db)).toEqual([]);
    } finally { db.close(); }
  });

'''
write('apps/api/src/drizzle.test.ts', helpers + head + tail)

# Keep current README/API guidance, replacing only the removed migration policy.
readme = read_main('README.md')
readme = readme.replace('SQLite / Node.js標準の`node:sqlite`', 'SQLite / Drizzle ORM / better-sqlite3')
readme = readme.replace('| DB変更履歴       | SQLマイグレーション                 | `db/migrations`       |', '| DB変更履歴       | Drizzle Kit                        | `db/drizzle`          |')
start = readme.index('通常の開発に別のDBサーバーやDocker、Pythonのインストールは不要です。')
end = readme.index('\n## 設定', start)
readme = readme[:start] + '''通常の開発に別のDBサーバーやDockerは不要です。SQLiteドライバーのネイティブビルドが必要な環境ではPythonとC++ビルドツールを用意してください。
DBスキーマ・変更履歴はDrizzleへ統一しました。既存の最新`spatial-v1`（旧002・003適用済み）のrevision・下書き・BattleSpecは保持し、旧管理テーブルのみ削除します。
既存DBはバックアップし、APIを停止して`vp run db:migrate`を実行してください。
旧`local-v1`の業務データを3D定義へ自動変換する機能はありません。既存の無関係なテーブル・行は削除しません。
新しい開発用DBが必要なら`.env`の`DATABASE_PATH`を未使用のファイル名に変更してください。自前resetや世代管理はありません。
[Drizzleの移行・制約](docs/adr/0005-drizzle-kit.md)を参照してください。
''' + readme[end:]
readme = '\n'.join(line for line in readme.split('\n') if not line.startswith('| `vp run db:reset'))
readme = readme.replace('SQLマイグレーションを適用', 'Drizzle Kitで未適用SQLを適用')
needle = next(line for line in readme.splitlines() if line.startswith('| `vp run db:migrate`'))
readme = readme.replace(needle, needle + '\n| `vp run db:generate` | TypeScriptスキーマからSQL・snapshotを生成 |\n| `vp run db:check` | Drizzle Kitの履歴整合性検査 |')
readme = readme.replace('ルートの`db/migrations`と`data/spatial`', 'ルートの`db/drizzle`と`data/spatial`').replace('起動・DB世代確認', '起動・Drizzle接続確認')
start = readme.index('`db/migrations`に連番のSQLファイルを追加すると')
end = readme.index('\n設計と拡張時の作業方針', start)
readme = readme[:start] + '''`apps/api/src/db/schema.ts`を変更し、`vp run db:generate`で生成したSQLとsnapshotを`db/drizzle`へコミットします。
`vp run db:check`で履歴を検査し、SQLレビュー後に`vp run db:migrate`を実行します。
API起動時も同じSQLと公式`__drizzle_migrations`を使います。自前runner・世代管理・チェックサム台帳はありません。
既存SQLは編集せず追記します。CIはKit検査、生成差分、実DB適用・再実行・失敗rollback・Git上の履歴不変性を検証します。
Drizzleが過去SQLの実行時改変検出を保証するわけではありません。レビュー済みSQLを迂回する`drizzle-kit push`は使用しません。
`STRICT`と不変revision/仕様のtriggerはレビュー済みSQLで維持します。将来のテーブル再作成時にも保持してください。
公開revision・下書きの競合検出・BattleSpecはDrizzle ORMへ移行し、Zodによる実行時検証は維持しています。
''' + readme[end:]
write('README.md', readme)
agents = Path('AGENTS.md').read_text().replace('data/characters', 'data/spatial').replace('ADR 0004', 'ADR 0005')
write('AGENTS.md', agents)
for p in [Path('docs/adr/0003-schema-generations.md'), Path('docs/development/quality.md')]:
    text = p.read_text().replace('0004-drizzle-kit.md', '0005-drizzle-kit.md').replace('ADR 0004', 'ADR 0005')
    text = text.replace('foreign-key constraints and descending history indexes', 'kind/JSON constraints, composite keys and immutable triggers')
    p.write_text(text)
Path('docs/adr/0004-drizzle-kit.md').unlink(missing_ok=True)
write('docs/adr/0005-drizzle-kit.md', '''# Drizzle Kit owns schema evolution

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
''')
adr = read_main('docs/adr/0004-spatial-persistence.md')
start = adr.index('共有migration runner')
end = adr.index('\n\n公開revision', start)
adr = adr[:start] + '保存モデルの決定は維持する。マイグレーション・世代検証・resetの運用は\n[ADR 0005](0005-drizzle-kit.md)によりDrizzle Kitへ置換した。旧実行系/APIの互換は追加しない。' + adr[end:]
start = adr.index('新規DBへの明示的な切替例:')
end = adr.index('サンプルは`data/spatial', start)
adr = adr[:start] + '新規DBへ切り替える場合は`.env`の`DATABASE_PATH`に未使用のファイル名を指定し、\n`pnpm db:migrate`を実行する。自前resetは廃止し、既存ファイルを削除しない。\n' + adr[end:]
write('docs/adr/0004-spatial-persistence.md', adr)
print('Current spatial persistence integrated with Drizzle; generate and review the new baseline next.')
