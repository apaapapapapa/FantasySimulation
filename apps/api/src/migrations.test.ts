import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vite-plus/test';
import { migrate, readMigrationSet, resetDevelopmentDatabase } from './migrations.ts';
import type { MigrationSet } from './migrations.ts';
const dirs: string[] = [];
function target() {
  const dir = mkdtempSync(join(tmpdir(), 'fantasy-db-test-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function migration(name: string, sql: string) {
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
const current = () => readMigrationSet();
it('initializes the current schema twice using the same application runner', () => {
  const db = new DatabaseSync(target());
  try {
    migrate(db);
    db.prepare("INSERT INTO characters VALUES ('preserved', '{}', 'test')").run();
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(before);
    expect(db.prepare('SELECT id FROM characters').get()?.id).toBe('preserved');
  } finally {
    db.close();
  }
});
it('refuses modified, missing, reordered and corrupt applied receipts', () => {
  for (const mode of ['modified', 'missing', 'reordered', 'corrupt'] as const) {
    const db = new DatabaseSync(target());
    try {
      const set = current();
      migrate(db, set);
      if (mode === 'modified') set.migrations[0] = migration(set.migrations[0]!.name, 'SELECT 2;');
      if (mode === 'missing') set.migrations = [];
      if (mode === 'reordered') set.migrations.unshift(migration('000_before.sql', 'SELECT 1;'));
      if (mode === 'corrupt') db.prepare("UPDATE schema_migrations SET checksum='incorrect'").run();
      expect(() => migrate(db, set)).toThrow(/migration (missing|checksum)/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count).toBe(1);
    } finally {
      db.close();
    }
  }
});
it('rolls back schema and receipts on both fresh and appended SQL failure', () => {
  for (const initialized of [false, true]) {
    const db = new DatabaseSync(target());
    try {
      const set = current();
      if (initialized) migrate(db, set);
      const before = db.prepare('SELECT name FROM sqlite_schema ORDER BY name').all();
      set.migrations.push(
        migration(
          '002_broken.sql',
          'CREATE TABLE partial(id TEXT); INSERT INTO absent VALUES (1);',
        ),
      );
      expect(() => migrate(db, set)).toThrow();
      expect(db.prepare('SELECT name FROM sqlite_schema ORDER BY name').all()).toEqual(before);
    } finally {
      db.close();
    }
  }
});
it('rejects unsupported databases without deleting their data', () => {
  for (const legacy of [false, true]) {
    const db = new DatabaseSync(target());
    try {
      if (legacy)
        db.exec(
          "CREATE TABLE sqlitevaluable(value TEXT); INSERT INTO sqlitevaluable VALUES ('keep');",
        );
      else {
        migrate(db);
        db.exec("UPDATE schema_generation SET generation='other-v2'");
      }
      const before = db.prepare('SELECT name FROM sqlite_schema ORDER BY name').all();
      expect(() => migrate(db)).toThrow(/Unsupported database/);
      expect(db.prepare('SELECT name FROM sqlite_schema ORDER BY name').all()).toEqual(before);
      if (legacy) expect(db.prepare('SELECT value FROM sqlitevaluable').get()?.value).toBe('keep');
    } finally {
      db.close();
    }
  }
});
it('requires explicit reset confirmation and a nonexisting destination', () => {
  const file = target(),
    set = current();
  expect(() => resetDevelopmentDatabase(file, 'wrong', set)).toThrow(
    /confirmation|confirm-generation/,
  );
  resetDevelopmentDatabase(file, set.declaration.generation, set);
  const before = readFileSync(file);
  expect(() => resetDevelopmentDatabase(file, set.declaration.generation, set)).toThrow(/EEXIST/);
  expect(readFileSync(file)).toEqual(before);
});
it('initializes a newly declared generation without keeping an old runtime', () => {
  const db = new DatabaseSync(target());
  try {
    const set: MigrationSet = {
      declaration: { generation: 'spatial-v2', decision: 'docs/adr/new-schema.md' },
      migrations: [migration('001_spatial.sql', 'CREATE TABLE spatial(id TEXT);')],
    };
    migrate(db, set);
    migrate(db, set);
    expect(db.prepare('SELECT generation FROM schema_generation').get()?.generation).toBe(
      'spatial-v2',
    );
  } finally {
    db.close();
  }
});
