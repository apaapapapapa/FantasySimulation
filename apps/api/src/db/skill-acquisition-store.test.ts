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
import { SkillAcquisitionStore } from './skill-acquisition-store.ts';
import { openStore, type Store } from './store.ts';

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('skill acquisition persistence', () => {
  it('CAS-saves advisory learning while preserving immutable historical revisions', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const fixture = await skillPersistenceFixture(store, 'acquisition'),
      acquisitions = new SkillAcquisitionStore(store),
      created = await acquisitions.create({
        selection: {
          schemaVersion: 1,
          id: 'acquisition.fixture',
          version: 1,
          character: reference(fixture.character),
          catalog: fixture.catalogRecord.reference,
          learnedNodeIds: [fixture.target],
        },
      });
    expect(created.snapshot).toMatchObject({
      policyVersion: 'skill-acquisition-v1',
      learnedNodeIds: [fixture.target],
      eligibilityNodeIds: expect.arrayContaining([fixture.target, fixture.alternate]),
    });

    const respecSelection = {
      schemaVersion: 1 as const,
      id: created.id,
      version: 2,
      character: created.snapshot.character,
      catalog: created.snapshot.catalog,
      learnedNodeIds: [],
    };
    const respec = await acquisitions.patch(created.id, {
      expectedVersion: 1,
      selection: respecSelection,
    });
    expect(respec.snapshot.learnedNodeIds).toEqual([]);
    await expect(
      acquisitions.patch(created.id, {
        expectedVersion: 1,
        selection: respecSelection,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(acquisitions.revision(created.latest)).resolves.toEqual(created.snapshot);
    expect(created.authoritativeBoundary).toBe(false);
    expect(() =>
      store.db.prepare("UPDATE skill_acquisition_revisions SET learned_json='[]'").run(),
    ).toThrow(/immutable/);
    expect(() => store.db.prepare('DELETE FROM skill_acquisition_revisions').run()).toThrow(
      /cannot be deleted/,
    );
  });

  it('rejects tagged nodes when no authoritative equipment tag source exists', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const fixture = await skillPersistenceFixture(store, 'acquisition-applicability'),
      acquisitions = new SkillAcquisitionStore(store);
    fixture.catalog.nodes = fixture.catalog.nodes.map((node) =>
      node.id === fixture.target ? { ...node, weaponTags: ['weapon.sword'] } : node,
    );
    fixture.catalog.revision++;
    const catalog = await fixture.skills.seedCatalog(fixture.catalog);
    await expect(
      acquisitions.create({
        selection: {
          schemaVersion: 1,
          id: 'acquisition.tagged',
          version: 1,
          character: reference(fixture.character),
          catalog: catalog.reference,
          learnedNodeIds: [fixture.target],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('adds strict acquisition tables to an old database without changing saved rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fantasy-skill-acquisition-')),
      old = join(directory, 'old-migrations'),
      filename = join(directory, 'old.sqlite'),
      migrations = join(repositoryRoot, 'db/drizzle');
    directories.push(directory);
    cpSync(migrations, old, { recursive: true });
    const journalPath = join(old, 'meta/_journal.json'),
      journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>;
      };
    journal.entries = journal.entries.filter(({ idx }) => idx < 6);
    writeFileSync(journalPath, JSON.stringify(journal));
    unlinkSync(join(old, '0006_tan_korath.sql'));
    const sqlite = new Database(filename);
    migrate(drizzle(sqlite), { migrationsFolder: old });
    sqlite.prepare('INSERT INTO battle_specs VALUES(?,?,?)').run('saved', '{}', 'before');
    sqlite.close();
    const store = openStore(filename);
    stores.push(store);
    expect(store.db.prepare('SELECT * FROM battle_specs').all()).toEqual([
      { simulation_hash: 'saved', manifest_json: '{}', created_at: 'before' },
    ]);
    for (const name of ['skill_acquisition_revisions', 'skill_acquisition_heads'])
      expect(
        store.db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(name),
      ).toEqual({ strict: 1 });
  });
});
