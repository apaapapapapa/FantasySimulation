import { execFileSync, spawnSync } from 'node:child_process';
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
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'fantasy-drizzle-'));
  directories.push(directory);
  return directory;
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

describe('Drizzle Kit and ORM migration integration', () => {
  it('builds STRICT tables with JSON checks, foreign keys and the descending history index', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      migrate(drizzle(sqlite), { migrationsFolder });
      const tables = sqlite
        .prepare<[], { name: string; strict: number }>('PRAGMA table_list')
        .all();
      for (const name of ['characters', 'rulesets', 'battles'])
        expect(tables.find((table) => table.name === name)?.strict).toBe(1);
      expect(
        tables.some((table) => ['schema_generation', 'schema_migrations'].includes(table.name)),
      ).toBe(false);
      expect(() =>
        sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('invalid', '{', 'now'),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run(null, '{}', 'now'),
      ).toThrow(/NOT NULL constraint failed/);
      expect(() =>
        sqlite
          .prepare('INSERT INTO characters VALUES (?, ?, ?)')
          .run('blob', Buffer.from('{}'), 'now'),
      ).toThrow(/cannot store BLOB value in TEXT column/);
      expect(() =>
        sqlite.prepare('INSERT INTO rulesets VALUES (?, ?)').run('invalid', '{'),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        sqlite
          .prepare('INSERT INTO battles VALUES (?, ?, ?, ?)')
          .run('invalid', 'missing', '{}', 'now'),
      ).toThrow(/FOREIGN KEY constraint failed/);
      sqlite.prepare('INSERT INTO rulesets VALUES (?, ?)').run('test', '{}');
      expect(() =>
        sqlite
          .prepare('INSERT INTO battles VALUES (?, ?, ?, ?)')
          .run('invalid', 'test', '{', 'now'),
      ).toThrow(/CHECK constraint failed/);
      const index = sqlite
        .prepare<[], { name: string | null; desc: number; key: number }>(
          "PRAGMA index_xinfo('battles_created_at')",
        )
        .all();
      expect(
        index.filter((column) => column.key === 1).map(({ name, desc }) => ({ name, desc })),
      ).toEqual([
        { name: 'created_at', desc: 1 },
        { name: 'id', desc: 1 },
      ]);
      expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      sqlite.close();
    }
  });

  it('shares the official history between Kit, startup and repeated execution', () => {
    const filename = join(temporary(), 'fresh.sqlite');
    runKit(['migrate'], filename);
    const first = new Database(filename);
    const before = receipts(first);
    first.close();
    expect(before.length).toBeGreaterThan(0);
    const store = openStore(filename);
    try {
      store.seedCharacters(readSampleCharacters());
    } finally {
      store.close();
    }
    runKit(['migrate'], filename);
    const second = new Database(filename);
    try {
      expect(receipts(second)).toEqual(before);
      expect(second.prepare('SELECT id FROM characters').all()).toHaveLength(2);
    } finally {
      second.close();
    }
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
      sqlite.exec(
        readFileSync(join(repositoryRoot, 'apps/api/test-fixtures/local-v1.sql'), 'utf8'),
      );
      sqlite
        .prepare('INSERT INTO characters VALUES (?, ?, ?)')
        .run(edited.id, JSON.stringify(edited), record.createdAt);
      sqlite
        .prepare('INSERT INTO rulesets VALUES (?, ?)')
        .run(DEFAULT_RULESET.version, JSON.stringify(DEFAULT_RULESET));
      sqlite
        .prepare('INSERT INTO battles VALUES (?, ?, ?, ?)')
        .run(record.id, DEFAULT_RULESET.version, JSON.stringify(record), record.createdAt);
    } finally {
      sqlite.close();
    }
    runKit(['migrate'], filename);
    const store = openStore(filename);
    try {
      store.seedCharacters(readSampleCharacters());
      expect(store.getCharacter(edited.id)).toEqual(edited);
      expect(store.listBattles()).toEqual([record]);
      expect(() => store.registerRuleset(DEFAULT_RULESET)).not.toThrow();
      expect(() => store.registerRuleset({ ...DEFAULT_RULESET, maxRounds: 2 })).toThrow(
        'version bump',
      );
    } finally {
      store.close();
    }
    const check = new Database(filename);
    try {
      expect(
        check.prepare('SELECT definition FROM characters WHERE id = ?').get(edited.id),
      ).toEqual({ definition: JSON.stringify(edited) });
      expect(
        check
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('schema_generation', 'schema_migrations')",
          )
          .all(),
      ).toEqual([]);
      expect(check.pragma('foreign_key_check')).toEqual([]);
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      check.close();
    }
  }, 90000);

  it('rolls back failed migration DDL and receipts using the official migrator', () => {
    const copy = join(temporary(), 'migrations');
    cpSync(migrationsFolder, copy, { recursive: true });
    const initial = readdirSync(copy)
      .filter((name) => name.endsWith('.sql'))
      .sort()[0];
    if (!initial) throw new Error('Missing generated migration');
    const file = join(copy, initial);
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        '\n--> statement-breakpoint\nCREATE TABLE rollback_probe (id INTEGER);\n--> statement-breakpoint\nINSERT INTO deliberately_missing_table VALUES (1);\n',
    );
    const sqlite = new Database(':memory:');
    try {
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: copy })).toThrow();
      expect(
        sqlite
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('characters', 'rulesets', 'battles', 'rollback_probe')",
          )
          .all(),
      ).toEqual([]);
      expect(receipts(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('does not drop legacy receipts or data if adoption fails', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(
        readFileSync(join(repositoryRoot, 'apps/api/test-fixtures/local-v1.sql'), 'utf8'),
      );
      sqlite.exec(
        'DROP INDEX battles_created_at; ALTER TABLE battles RENAME COLUMN created_at TO unexpected_column;',
      );
      sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('preserved', '{}', 'now');
      expect(() => migrate(drizzle(sqlite), { migrationsFolder })).toThrow();
      expect(sqlite.prepare('SELECT id FROM characters').all()).toEqual([{ id: 'preserved' }]);
      expect(sqlite.prepare('SELECT name FROM schema_migrations').all()).toEqual([
        { name: '001_initial.sql' },
      ]);
      expect(receipts(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
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
      sqlite.prepare('INSERT INTO characters VALUES (?, ?, ?)').run('existing', '{}', 'before');
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
        'ALTER TABLE characters ADD COLUMN migration_probe TEXT;\n',
      );
      migrate(db, { migrationsFolder: output });
      const after = receipts(sqlite);
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        sqlite.prepare('SELECT id, definition, updated_at, migration_probe FROM characters').all(),
      ).toEqual([
        { id: 'existing', definition: '{}', updated_at: 'before', migration_probe: null },
      ]);
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
