import { expect, it } from 'vite-plus/test';
import { migrationChanges } from './migrations.ts';
import type { MigrationSet } from '../../apps/api/src/migrations.ts';
const decision = 'docs/adr/old.md';
const previous = {
  declaration: { generation: 'local-v1', decision },
  sql: { '001_initial.sql': 'SELECT 1;' },
  decisions: [decision],
};
function set(generation = 'local-v1', nextDecision = decision): MigrationSet {
  return {
    declaration: { generation, decision: nextDecision },
    migrations: [{ name: '001_initial.sql', sql: 'SELECT 1;', checksum: 'unused-by-diff' }],
  };
}
it('enforces append-only SQL including the first schema declaration', () => {
  const valid = set();
  valid.migrations.push({ name: '002_added.sql', sql: 'SELECT 2;', checksum: 'unused' });
  expect(migrationChanges(previous, valid)).toEqual([]);
  for (const baseline of [previous, { ...previous, declaration: null }]) {
    const changed = set();
    changed.migrations[0]!.sql = 'SELECT 9;';
    expect(migrationChanges(baseline, changed)).toHaveLength(1);
    expect(migrationChanges(baseline, { ...set(), migrations: [] })).toHaveLength(1);
  }
  const backdated = set();
  backdated.migrations.push({ name: '000_early.sql', sql: 'SELECT 0;', checksum: 'unused' });
  expect(migrationChanges(previous, backdated)).toHaveLength(1);
});
it('permits a generation replacement only with a distinct ADR', () => {
  expect(migrationChanges(previous, { ...set('spatial-v2'), migrations: [] })).toHaveLength(1);
  expect(
    migrationChanges(previous, {
      ...set('spatial-v2', 'docs/adr/new.md'),
      migrations: [{ name: '001_spatial.sql', sql: 'SELECT 2;', checksum: 'unused' }],
    }),
  ).toEqual([]);
});
