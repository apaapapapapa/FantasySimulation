import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { repositoryRoot } from './config.ts';

export const SchemaDeclaration = z
  .object({
    generation: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    decision: z.string().regex(/^docs\/adr\/[a-z0-9-]+\.md$/),
  })
  .strict();
export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}
export interface MigrationSet {
  declaration: z.infer<typeof SchemaDeclaration>;
  migrations: Migration[];
}
export function readMigrationSet(root = repositoryRoot): MigrationSet {
  const declaration = SchemaDeclaration.parse(
    JSON.parse(readFileSync(join(root, 'db/schema.json'), 'utf8')),
  );
  if (!readFileSync(join(root, declaration.decision), 'utf8').trim())
    throw Error('Schema decision is empty');
  const directory = join(root, 'db/migrations');
  const names = readdirSync(directory).sort();
  if (
    !names.length ||
    names.some((name) => !/^\d{3}_[a-z0-9_-]+\.sql$/.test(name)) ||
    new Set(names.map((name) => name.slice(0, 3))).size !== names.length
  )
    throw Error('Migrations require unique numbered SQL files');
  const migrations = names.map((name) => {
    const sql = readFileSync(join(directory, name), 'utf8');
    if (!sql.trim()) throw Error(`Empty migration: ${name}`);
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  return { declaration, migrations };
}

/** The application's single migration runner. Every startup and disposable check uses it. */
export function migrate(db: DatabaseSync, set = readMigrationSet()): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all();
    if (!tables.length) {
      db.exec(`CREATE TABLE schema_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL) STRICT;
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL) STRICT;`);
      db.prepare('INSERT INTO schema_generation (id, generation) VALUES (1, ?)').run(
        set.declaration.generation,
      );
    } else {
      if (
        !tables.some((table) => table.name === 'schema_generation') ||
        !tables.some((table) => table.name === 'schema_migrations')
      )
        throw Error(
          'Unsupported database: no schema generation. Create a new development database with db:reset.',
        );
      const generations = db.prepare('SELECT id, generation FROM schema_generation').all();
      if (
        generations.length !== 1 ||
        generations[0]?.id !== 1 ||
        generations[0]?.generation !== set.declaration.generation
      )
        throw Error(
          `Unsupported database generation; expected ${set.declaration.generation}. Use an explicitly new db:reset target.`,
        );
    }
    const applied = db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY name').all();
    for (const [index, previous] of applied.entries()) {
      const current = set.migrations[index];
      if (!current || current.name !== previous.name)
        throw Error(`Applied migration missing or reordered: ${String(previous.name)}`);
      if (current.checksum !== previous.checksum)
        throw Error(`Applied migration checksum mismatch: ${current.name}`);
    }
    for (const migration of set.migrations.slice(applied.length)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)').run(
        migration.name,
        migration.checksum,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Explicit reset creates a new destination; it never opens, truncates or deletes an existing DB. */
export function resetDevelopmentDatabase(
  filename: string,
  confirmation: string,
  set = readMigrationSet(),
): void {
  if (confirmation !== set.declaration.generation || filename === ':memory:')
    throw Error('Reset requires a new file and the exact --confirm-generation value');
  mkdirSync(dirname(filename), { recursive: true });
  closeSync(openSync(filename, 'wx', 0o600));
  const db = new DatabaseSync(filename);
  try {
    migrate(db, set);
  } finally {
    db.close();
  }
}
