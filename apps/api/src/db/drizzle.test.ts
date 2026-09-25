import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { canonicalJson, RevisionSchema } from '@fantasy/domain/spatial';
import { prepareBattle, reference } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { repositoryRoot } from '../config.ts';
import { openStore, readSampleRevisions } from './store.ts';

const migrationsFolder = join(repositoryRoot, 'db/drizzle');
const kit = join(repositoryRoot, 'node_modules/drizzle-kit/bin.cjs');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'fantasy-drizzle-'));
  directories.push(directory);
  return directory;
}
function historyBefore(exclusiveIndex: number) {
  const old = join(temporary(), 'history');
  cpSync(migrationsFolder, old, { recursive: true });
  const journalPath = join(old, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < exclusiveIndex);
  writeFileSync(journalPath, JSON.stringify(journal));
  return old;
}
function runKit(args: string[], filename: string, cwd = repositoryRoot) {
  const result = spawnSync(process.execPath, [kit, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, DATABASE_PATH: filename },
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  // Kit can report some generation failures with exit 0. A no-diff assertion
  // alone would incorrectly pass when snapshot loading never succeeded.
  if (result.status !== 0 || /Error:|ENOENT|malformed|unsupported version/.test(output))
    throw new Error(output);
  expect(result.status).toBe(0);
  return output;
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
    })
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
}

function temporaryKitConfig(directory: string) {
  const config = join(directory, 'drizzle.config.ts');
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      dialect: 'sqlite',
      schema: resolve(repositoryRoot, 'apps/api/src/db/schema.ts').replaceAll('\\', '/'),
      out: './drizzle',
    })};\n`,
  );
  return config;
}

const legacyFixture = () =>
  readFileSync(join(repositoryRoot, 'apps/api/test-fixtures/spatial-v1.sql'), 'utf8');
function failingMigrations() {
  const copy = join(temporary(), 'migrations');
  cpSync(migrationsFolder, copy, { recursive: true });
  const initial = readdirSync(copy)
    .filter((name) => name.endsWith('.sql'))
    .sort()[0];
  if (!initial) throw new Error('Missing generated migration');
  const path = join(copy, initial);
  writeFileSync(
    path,
    readFileSync(path, 'utf8') +
      '\n--> statement-breakpoint\nCREATE TABLE rollback_probe(id INTEGER);\n--> statement-breakpoint\nINSERT INTO deliberately_missing_table VALUES(1);\n',
  );
  return copy;
}

describe('Drizzle Kit and spatial persistence integration', () => {
  it('builds STRICT tables, JSON and kind checks, composite keys and immutable triggers', () => {
    const db = new Database(':memory:');
    try {
      migrate(drizzle(db), { migrationsFolder });
      const tables = db.prepare<[], { name: string; strict: number }>('PRAGMA table_list').all();
      for (const name of [
        'published_revisions',
        'definition_drafts',
        'battle_specs',
        'simulation_jobs',
        'simulation_attempts',
        'battle_results',
        'replay_artifacts',
        'attempt_metrics',
        'runtime_owner',
      ])
        expect(tables.find((table) => table.name === name)?.strict).toBe(1);
      expect(
        tables.some((table) =>
          ['schema_generation', 'schema_migrations', 'characters', 'rulesets', 'battles'].includes(
            table.name,
          ),
        ),
      ).toBe(false);
      const insert = db.prepare('INSERT INTO published_revisions VALUES(?,?,?,?,?,?)');
      expect(() => insert.run('invalid', 'id', 1, 'hash', '{}', 'now')).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insert.run('policy', 'id', 0, 'hash', '{}', 'now')).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insert.run('policy', 'id', 1, 'hash', '{', 'now')).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insert.run('policy', null, 1, 'hash', '{}', 'now')).toThrow(
        /NOT NULL constraint failed/,
      );
      expect(() => insert.run('policy', 'id', 1, 'hash', Buffer.from('{}'), 'now')).toThrow(
        /cannot store BLOB value in TEXT column/,
      );
      insert.run('policy', 'id', 1, 'hash', '{}', 'now');
      expect(() => insert.run('policy', 'id', 1, 'hash', '{}', 'now')).toThrow(
        /UNIQUE constraint failed/,
      );
      expect(() => db.prepare('UPDATE published_revisions SET revision=2').run()).toThrow(
        /immutable/,
      );
      expect(() => db.prepare('DELETE FROM published_revisions').run()).toThrow(
        /cannot be deleted/,
      );
      expect(() =>
        db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run(null, '{}', 'now'),
      ).toThrow(/NOT NULL constraint failed/);
      expect(() =>
        db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('hash', '{', 'now'),
      ).toThrow(/CHECK constraint failed/);
      db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('hash', '{}', 'now');
      expect(() => db.prepare("UPDATE battle_specs SET manifest_json='{}'").run()).toThrow(
        /immutable/,
      );
      expect(() => db.prepare('DELETE FROM battle_specs').run()).toThrow(/cannot be deleted/);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()).toHaveLength(
        6,
      );
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('adds a typed determinism failure without changing previously saved rows or retry restrictions', () => {
    const old = historyBefore(3),
      upgraded = historyBefore(4);
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: old });
      sqlite.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('saved', '{}', 'before');
      const insert = sqlite.prepare(`INSERT INTO simulation_jobs
        (id,simulation_hash,client_id,idempotency_key,request_hash,budget_json,state,attempts,max_attempts,error,created_at,updated_at)
        VALUES(?, 'saved','client',?,'hash','{}','failed',1,3,?,100,101)`);
      insert.run('conflict', 'one', 'Determinism violation');
      insert.run('ordinary', 'two', 'Worker stopped');
      const before = sqlite.prepare('SELECT * FROM simulation_jobs ORDER BY id').all();
      const priorReceipts = receipts(sqlite);
      migrate(db, { migrationsFolder: upgraded });
      const after = sqlite
        .prepare<[], { failure_code: string | null } & Record<string, unknown>>(
          'SELECT * FROM simulation_jobs ORDER BY id',
        )
        .all();
      expect(after.map(({ failure_code: _, ...row }) => row)).toEqual(before);
      expect(after.map((row) => row.failure_code)).toEqual(['determinism-violation', null]);
      expect(receipts(sqlite).slice(0, priorReceipts.length)).toEqual(priorReceipts);
      expect(receipts(sqlite)).toHaveLength(priorReceipts.length + 1);
      migrate(db, { migrationsFolder: upgraded });
      expect(sqlite.prepare('SELECT * FROM simulation_jobs ORDER BY id').all()).toEqual(after);
      expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      sqlite.close();
    }
  });

  it('adds nullable replay validation metadata without rewriting old artifacts or results', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite),
        upgraded = historyBefore(5);
      migrate(db, { migrationsFolder: historyBefore(4) });
      sqlite.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('saved', '{}', 'before');
      sqlite
        .prepare(`INSERT INTO simulation_jobs
        (id,simulation_hash,client_id,idempotency_key,request_hash,budget_json,state,attempts,max_attempts,created_at,updated_at)
        VALUES('job','saved','client','key','hash','{}','completed',1,3,100,101)`)
        .run();
      sqlite
        .prepare(`INSERT INTO simulation_attempts
        (id,job_id,number,token,state,budget_json,lease_until,started_at)
        VALUES('attempt','job',1,'token','completed','{}',100,99)`)
        .run();
      sqlite
        .prepare(
          `INSERT INTO replay_artifacts VALUES('replay','attempt','checksum',123,'ready',100)`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO battle_results VALUES('result','saved','saved','attempt','hash','{}','replay',100)`,
        )
        .run();
      const artifact = sqlite.prepare('SELECT * FROM replay_artifacts').get();
      const result = sqlite.prepare('SELECT * FROM battle_results').get();
      const oldReceipts = receipts(sqlite);
      const triggers = sqlite
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
        .all();
      migrate(db, { migrationsFolder: upgraded });
      expect(sqlite.prepare('SELECT * FROM replay_artifacts').get()).toEqual({
        ...artifact!,
        validation_profile: null,
      });
      expect(sqlite.prepare('SELECT * FROM battle_results').get()).toEqual(result);
      expect(receipts(sqlite).slice(0, oldReceipts.length)).toEqual(oldReceipts);
      expect(receipts(sqlite)).toHaveLength(oldReceipts.length + 1);
      expect(
        sqlite
          .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
          .all(),
      ).toEqual(triggers);
      expect(
        sqlite.prepare("SELECT strict FROM pragma_table_list WHERE name='replay_artifacts'").get(),
      ).toEqual({ strict: 1 });
      migrate(db, { migrationsFolder: upgraded });
      expect(receipts(sqlite)).toHaveLength(oldReceipts.length + 1);
      expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      sqlite.close();
    }
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
      expect(store.listRevisions('character').items).toHaveLength(20);
    } finally {
      store.close();
    }
    runKit(['migrate'], filename);
    const second = new Database(filename);
    try {
      expect(receipts(second)).toEqual(before);
    } finally {
      second.close();
    }
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
        db.prepare('INSERT INTO published_revisions VALUES(?,?,?,?,?,?)').run(
          r.kind,
          r.id,
          r.revision,
          r.contentHash,
          canonicalJson(r),
          now,
        );
      db.prepare('INSERT INTO definition_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(
        id,
        character.kind,
        character.id,
        3,
        canonicalJson(definition),
        null,
        now,
        now,
        canonicalJson(reference(character)),
      );
      db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run(
        battle.simulationHash,
        canonicalJson(battle.manifest),
        now,
      );
    } finally {
      db.close();
    }
    runKit(['migrate'], filename);
    const store = openStore(filename);
    try {
      await store.seedRevisions(readSampleRevisions());
      expect(store.getRevision('character', character.id, character.revision)).toEqual(character);
      expect(store.getDraft(id)).toMatchObject({
        id,
        definition,
        base: reference(character),
        version: 3,
        published: null,
      });
      expect(store.getSpec(battle.simulationHash)).toEqual({
        simulationHash: battle.simulationHash,
        manifest: battle.manifest,
      });
      expect(
        store.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('schema_generation','schema_migrations')",
          )
          .all(),
      ).toEqual([]);
      expect(
        store.db
          .prepare(
            'SELECT revision_json FROM published_revisions WHERE kind=? AND definition_id=? AND revision=?',
          )
          .get(character.kind, character.id, character.revision),
      ).toEqual({ revision_json: canonicalJson(character) });
      expect(store.db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      store.close();
    }
  }, 90000);

  it('rolls back failed initial migration DDL and official receipts', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migrate(drizzle(db), { migrationsFolder: failingMigrations() })).toThrow(
        /Failed to run the query '[\s\S]*INSERT INTO deliberately_missing_table VALUES\(1\);/,
      );
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('published_revisions','definition_drafts','battle_specs','rollback_probe')",
          )
          .all(),
      ).toEqual([]);
      expect(receipts(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('restores existing data and old receipts if the adoption transaction fails', () => {
    const db = new Database(':memory:');
    try {
      db.exec(legacyFixture());
      db.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('keep', '{}', 'before');
      expect(() => migrate(drizzle(db), { migrationsFolder: failingMigrations() })).toThrow(
        /Failed to run the query '[\s\S]*INSERT INTO deliberately_missing_table VALUES\(1\);/,
      );
      expect(db.prepare('SELECT simulation_hash FROM battle_specs').all()).toEqual([
        { simulation_hash: 'keep' },
      ]);
      expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()).toEqual([
        { name: '002_spatial_revisions.sql' },
        { name: '003_draft_base.sql' },
      ]);
      expect(receipts(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('applies a Kit-generated incremental migration without replaying earlier SQL', () => {
    const directory = temporary();
    const output = join(directory, 'drizzle');
    cpSync(migrationsFolder, output, { recursive: true });
    const filename = join(directory, 'incremental.sqlite');
    const sqlite = new Database(filename);
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: output });
      sqlite.prepare('INSERT INTO battle_specs VALUES (?, ?, ?)').run('existing', '{}', 'before');
      const before = receipts(sqlite);
      const files = new Set(readdirSync(output));
      const config = temporaryKitConfig(directory);
      runKit(
        ['generate', '--custom', '--name=incremental_probe', `--config=${config}`],
        filename,
        directory,
      );
      const generated = readdirSync(output).filter(
        (name) => name.endsWith('.sql') && !files.has(name),
      );
      expect(generated).toHaveLength(1);
      const migration = generated[0];
      if (!migration) throw new Error('Kit did not generate an incremental migration');
      writeFileSync(
        join(output, migration),
        'ALTER TABLE definition_drafts ADD COLUMN migration_probe TEXT;\n',
      );
      migrate(db, { migrationsFolder: output });
      expect(sqlite.prepare('SELECT migration_probe FROM definition_drafts').all()).toEqual([]);
      const after = receipts(sqlite);
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        sqlite.prepare('SELECT simulation_hash, manifest_json, created_at FROM battle_specs').all(),
      ).toEqual([{ simulation_hash: 'existing', manifest_json: '{}', created_at: 'before' }]);
      migrate(db, { migrationsFolder: output });
      expect(receipts(sqlite)).toEqual(after);
    } finally {
      sqlite.close();
    }
  }, 90000);

  it('keeps TypeScript schema and generated snapshots synchronized using Kit generate', () => {
    const directory = temporary();
    const output = join(directory, 'drizzle');
    cpSync(migrationsFolder, output, { recursive: true });
    const before = contents(output);
    const config = temporaryKitConfig(directory);
    const result = runKit(
      ['generate', `--config=${config}`],
      join(directory, 'unused.sqlite'),
      directory,
    );
    expect(result).toContain('No schema changes');
    expect(contents(output)).toEqual(before);
  }, 90000);

  it('keeps already committed Drizzle SQL and snapshots append-only with Git', () => {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 15000,
      });
    const base =
      process.env.MIGRATION_BASE_SHA || git(['merge-base', 'origin/main', 'HEAD']).trim();
    expect(base).toMatch(/^[a-f0-9]{40}$/);
    expect(
      git([
        'diff',
        '--name-only',
        '--diff-filter=MD',
        base,
        'HEAD',
        '--',
        'db/drizzle/*.sql',
        'db/drizzle/meta/*_snapshot.json',
      ]).trim(),
    ).toBe('');
  });
});
