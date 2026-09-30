import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { reference } from '@fantasy/engine/spatial';
import { skillPersistenceFixture } from '../../test-support/skills.ts';
import { repositoryRoot } from '../config.ts';
import { openStore } from './store.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'fantasy-skill-store-'));
  directories.push(directory);
  return directory;
}
async function fixture() {
  const store = openStore(':memory:');
  return { store, ...(await skillPersistenceFixture(store, 'api')) };
}

describe('skill persistence', () => {
  it('appends immutable loadout revisions and advances only the CAS head', async () => {
    const { store, skills, character, configuration } = await fixture();
    try {
      const first = await skills.create({ character: reference(character), configuration });
      expect(first).toMatchObject({ id: configuration.id, version: 1, latest: { revision: 1 } });
      const second = await skills.patch(configuration.id, {
        expectedVersion: 1,
        character: reference(character),
        configuration: { ...configuration, version: 2 },
      });
      expect(second).toMatchObject({ version: 2, latest: { revision: 2 } });
      expect(
        store.db.prepare('SELECT revision FROM skill_loadout_revisions ORDER BY revision').all(),
      ).toEqual([{ revision: 1 }, { revision: 2 }]);
      await expect(
        skills.patch(configuration.id, {
          expectedVersion: 1,
          character: reference(character),
          configuration: { ...configuration, version: 2 },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(() =>
        store.db.prepare("UPDATE skill_loadout_revisions SET created_at='tampered'").run(),
      ).toThrow(/immutable/);
      expect(() => store.db.prepare('DELETE FROM skill_catalog_revisions').run()).toThrow(
        /cannot be deleted/,
      );
    } finally {
      store.close();
    }
  });

  it('rejects catalog substitution without appending a head or revision', async () => {
    const { store, skills, character, configuration } = await fixture();
    try {
      await expect(
        skills.create({
          character: reference(character),
          configuration: {
            ...configuration,
            catalog: { ...configuration.catalog, contentHash: `sha256:${'3'.repeat(64)}` },
          },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(store.db.prepare('SELECT count(*) count FROM skill_loadout_heads').get()).toEqual({
        count: 0,
      });
      expect(store.db.prepare('SELECT count(*) count FROM skill_loadout_revisions').get()).toEqual({
        count: 0,
      });
    } finally {
      store.close();
    }
  });

  it('adds strict skill tables to an old database without changing saved rows', () => {
    const directory = temporary(),
      old = join(directory, 'old-migrations'),
      filename = join(directory, 'old.sqlite'),
      migrations = join(repositoryRoot, 'db/drizzle');
    cpSync(migrations, old, { recursive: true });
    const journalPath = join(old, 'meta/_journal.json'),
      journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>;
      };
    journal.entries = journal.entries.filter(({ idx }) => idx < 5);
    writeFileSync(journalPath, JSON.stringify(journal));
    unlinkSync(join(old, '0005_skill_persistence.sql'));
    const sqlite = new Database(filename);
    migrate(drizzle(sqlite), { migrationsFolder: old });
    sqlite.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('saved', '{}', 'before');
    sqlite.close();
    const store = openStore(filename);
    try {
      expect(store.db.prepare('SELECT * FROM battle_specs').all()).toEqual([
        { simulation_hash: 'saved', manifest_json: '{}', created_at: 'before' },
      ]);
      for (const name of [
        'skill_catalog_revisions',
        'skill_loadout_revisions',
        'skill_loadout_heads',
      ])
        expect(
          store.db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(name),
        ).toEqual({ strict: 1 });
    } finally {
      store.close();
    }
  });
});
