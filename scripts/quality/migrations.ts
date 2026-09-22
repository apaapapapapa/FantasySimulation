import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, readMigrationSet, SchemaDeclaration } from '../../apps/api/src/migrations.ts';
import type { MigrationSet } from '../../apps/api/src/migrations.ts';

interface Baseline {
  declaration: MigrationSet['declaration'] | null;
  sql: Record<string, string>;
  decisions: string[];
}
export function migrationChanges(previous: Baseline, current: MigrationSet): string[] {
  if (previous.declaration && previous.declaration.generation !== current.declaration.generation) {
    return previous.decisions.includes(current.declaration.decision)
      ? ['New schema generation requires a new reviewed ADR path in db/schema.json.']
      : [];
  }
  const findings: string[] = [];
  for (const [name, sql] of Object.entries(previous.sql)) {
    const next = current.migrations.find((m) => m.name === name);
    if (!next || next.sql !== sql)
      findings.push(
        `db/migrations/${name}: applied SQL changed or missing; append a migration or declare a reviewed new schema generation.`,
      );
  }
  const last = Object.keys(previous.sql).sort().at(-1);
  for (const migration of current.migrations)
    if (!(migration.name in previous.sql) && last && migration.name <= last)
      findings.push(`db/migrations/${migration.name}: migration must append after ${last}.`);
  return findings;
}
export function checkMigrations(
  root: string,
  requestedBase = process.env.MIGRATION_BASE_SHA,
): unknown[] {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const base = requestedBase || git(['merge-base', 'origin/main', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(base)) throw Error('Migration baseline is not a full commit SHA');
  git(['cat-file', '-e', `${base}^{commit}`]);
  const paths = git(['ls-tree', '-r', '--name-only', '-z', base, '--', 'db', 'docs/adr'])
    .split('\0')
    .filter(Boolean);
  const previous: Baseline = {
    declaration: paths.includes('db/schema.json')
      ? SchemaDeclaration.parse(JSON.parse(git(['show', `${base}:db/schema.json`])))
      : null,
    sql: Object.fromEntries(
      paths
        .filter((p) => p.startsWith('db/migrations/'))
        .map((p) => [p.slice('db/migrations/'.length), git(['show', `${base}:${p}`])]),
    ),
    decisions: paths.filter((p) => p.startsWith('docs/adr/')),
  };
  const current = readMigrationSet(root);
  if (
    !readFileSync(join(root, current.declaration.decision), 'utf8').includes(
      current.declaration.generation,
    )
  )
    throw Error('Schema ADR must describe the declared generation');
  const findings = migrationChanges(previous, current);
  const directory = mkdtempSync(join(tmpdir(), 'fantasy-migration-check-'));
  try {
    const db = new DatabaseSync(join(directory, 'fresh.sqlite'));
    try {
      migrate(db, current);
      const before = JSON.stringify(
        db.prepare('SELECT * FROM schema_migrations ORDER BY name').all(),
      );
      migrate(db, current);
      const after = JSON.stringify(
        db.prepare('SELECT * FROM schema_migrations ORDER BY name').all(),
      );
      if (before !== after)
        findings.push(
          'Migration reexecution changed applied receipts; make initialization idempotent.',
        );
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        findings.push('Fresh database integrity check failed.');
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return findings.map((reason) => ({
    path: 'db/migrations',
    baselineSha: base,
    reason,
    correction:
      'Use the shared SQLite runner and reviewed schema declaration; never mutate user databases in verification.',
  }));
}
