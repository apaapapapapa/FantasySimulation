import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { compareIds, skillBattleReceipt } from '@fantasy/domain';
import { reference, runBattle, sealRevision } from '@fantasy/engine/spatial';
import { skillPersistenceFixture } from '../../test-support/skills.ts';
import { repositoryRoot } from '../config.ts';
import { SkillAcquisitionStore } from './skill-acquisition-store.ts';
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
function loadoutCounts(store: ReturnType<typeof openStore>) {
  return {
    heads: store.db.prepare('SELECT count(*) count FROM skill_loadout_heads').get(),
    revisions: store.db.prepare('SELECT count(*) count FROM skill_loadout_revisions').get(),
  };
}

async function acquisitionFixture(
  store: ReturnType<typeof openStore>,
  input: Awaited<ReturnType<typeof skillPersistenceFixture>>,
  id: string,
) {
  return new SkillAcquisitionStore(store).create({
    selection: {
      schemaVersion: 1,
      id,
      version: 1,
      character: reference(input.character),
      catalog: input.catalogRecord.reference,
      learnedNodeIds: [input.target],
    },
  });
}

async function invalidAugment(mode: 'id' | 'trigger') {
  const store = openStore(':memory:');
  try {
    const input = await skillPersistenceFixture(store, `augment-${mode}`),
      node = input.catalog.nodes.find(({ id }) => id === input.target)!,
      baseRef = node.resolution[0]!.kind === 'active-ability' ? node.resolution[0]!.ability : null;
    if (!baseRef) throw new Error('Expected active fixture ability');
    const base = store.requireRevision('ability', baseRef);
    const { stages: _stages, ...reactionBase } = base.definition;
    const replacement = await sealRevision(
        'ability',
        `${base.id}.${mode}-substitute`,
        base.revision + 1,
        mode === 'trigger'
          ? {
              ...reactionBase,
              name: 'Invalid trigger augment',
              trigger: 'before-hit',
              target: 'self',
              attack: { kind: 'direct' },
              castSteps: 0,
              rangeMm: 0,
              costs: { hp: 0, mp: 0, uses: 0 },
              effects: [],
              reaction: { response: { kind: 'parry', scope: 'all' } },
            }
          : { ...base.definition, name: 'Invalid identity augment' },
      ),
      owner = await sealRevision('character', `character.augment-${mode}`, 1, {
        ...input.character.definition,
        abilities: [...input.character.definition.abilities, baseRef, reference(replacement)],
      });
    await store.seedRevisions([owner, replacement]);
    input.catalog.revision++;
    input.catalog.nodes = input.catalog.nodes.map((candidate) =>
      candidate.id === input.target
        ? {
            ...candidate,
            resolution: [
              {
                kind: 'augment' as const,
                baseAbility: baseRef,
                resolvedAbility: reference(replacement),
              },
            ],
          }
        : candidate,
    );
    const catalog = await input.skills.seedCatalog(input.catalog),
      acquisition = await new SkillAcquisitionStore(store).create({
        selection: {
          schemaVersion: 1,
          id: `acquisition.augment-${mode}`,
          version: 1,
          character: reference(owner),
          catalog: catalog.reference,
          learnedNodeIds: [input.target],
        },
      });
    return await input.skills.create({
      character: reference(owner),
      configuration: {
        schemaVersion: 2,
        id: `loadout.augment-${mode}`,
        version: 1,
        catalog: catalog.reference,
        acquisition: acquisition.latest,
        enabledNodeIds: [input.target],
      },
    });
  } finally {
    store.close();
  }
}

describe('skill persistence', () => {
  it('appends immutable loadout revisions and advances only the CAS head', async () => {
    const { store, skills, character, configuration } = await fixture();
    try {
      const first = await skills.createLegacy({ character: reference(character), configuration });
      expect(first).toMatchObject({ id: configuration.id, version: 1, latest: { revision: 1 } });
      const second = await skills.patchLegacy(configuration.id, {
        expectedVersion: 1,
        character: reference(character),
        configuration: { ...configuration, version: 2 },
      });
      expect(second).toMatchObject({ version: 2, latest: { revision: 2 } });
      expect(
        store.db.prepare('SELECT revision FROM skill_loadout_revisions ORDER BY revision').all(),
      ).toEqual([{ revision: 1 }, { revision: 2 }]);
      await expect(
        skills.patchLegacy(configuration.id, {
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
        skills.createLegacy({
          character: reference(character),
          configuration: {
            ...configuration,
            catalog: { ...configuration.catalog, contentHash: `sha256:${'3'.repeat(64)}` },
          },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(loadoutCounts(store)).toEqual({
        heads: { count: 0 },
        revisions: { count: 0 },
      });
    } finally {
      store.close();
    }
  });

  it('gives set-equivalent loadouts one canonical snapshot hash across stores', async () => {
    const firstStore = openStore(':memory:'),
      secondStore = openStore(':memory:');
    try {
      const first = await skillPersistenceFixture(firstStore, 'permutation'),
        second = await skillPersistenceFixture(secondStore, 'permutation'),
        ascending = [first.target, first.alternate].sort(compareIds),
        descending = [...ascending].reverse(),
        firstHead = await first.skills.createLegacy({
          character: reference(first.character),
          configuration: {
            ...first.configuration,
            eligibilityNodeIds: ascending,
            learnedNodeIds: ascending,
            enabledNodeIds: ascending,
          },
        }),
        secondHead = await second.skills.createLegacy({
          character: reference(second.character),
          configuration: {
            ...second.configuration,
            eligibilityNodeIds: descending,
            learnedNodeIds: descending,
            enabledNodeIds: descending,
          },
        });
      expect(firstHead.latest.contentHash).toBe(secondHead.latest.contentHash);
      expect(secondHead.snapshot.configuration).toEqual(firstHead.snapshot.configuration);
      expect(firstHead.snapshot.configuration).toMatchObject({
        eligibilityNodeIds: ascending,
        learnedNodeIds: ascending,
        enabledNodeIds: ascending,
      });
    } finally {
      firstStore.close();
      secondStore.close();
    }
  });

  it('rejects duplicate node IDs instead of silently canonicalizing them away', async () => {
    const { store, skills, character, configuration, target } = await fixture();
    try {
      await expect(
        skills.createLegacy({
          character: reference(character),
          configuration: {
            ...configuration,
            learnedNodeIds: [target, target],
          },
        }),
      ).rejects.toThrow('Skill node IDs must be unique');
      expect(loadoutCounts(store)).toEqual({
        heads: { count: 0 },
        revisions: { count: 0 },
      });
    } finally {
      store.close();
    }
  });

  it('upgrades V1 to V2 only with the same character and catalog identity', async () => {
    const input = await fixture();
    try {
      const { store, skills, character, configuration, catalogRecord } = input,
        first = await skills.createLegacy({ character: reference(character), configuration }),
        acquisition = await acquisitionFixture(store, input, 'acquisition.upgrade'),
        v2 = {
          schemaVersion: 2 as const,
          id: configuration.id,
          version: 2,
          catalog: catalogRecord.reference,
          acquisition: acquisition.latest,
          enabledNodeIds: configuration.enabledNodeIds,
        };
      await expect(
        skills.patch(configuration.id, {
          expectedVersion: 1,
          character: reference(character),
          configuration: v2,
        }),
      ).resolves.toMatchObject({ schemaVersion: 2, version: 2 });

      await expect(
        skills.patchLegacy(configuration.id, {
          expectedVersion: 2,
          character: reference(character),
          configuration: { ...configuration, version: 3 },
        }),
      ).rejects.toThrow('cannot downgrade');
      await expect(skills.head(configuration.id)).resolves.toMatchObject({
        schemaVersion: 2,
        version: 2,
      });

      const secondAcquisition = await acquisitionFixture(store, input, 'acquisition.substitute');
      await expect(
        skills.patch(configuration.id, {
          expectedVersion: 2,
          character: reference(character),
          configuration: { ...v2, version: 3, acquisition: secondAcquisition.latest },
        }),
      ).rejects.toThrow('identity cannot change');
      await expect(
        skills.patch(configuration.id, {
          expectedVersion: 2,
          character: { ...reference(character), contentHash: `sha256:${'9'.repeat(64)}` },
          configuration: { ...v2, version: 3 },
        }),
      ).rejects.toThrow('identity cannot change');
      await expect(
        skills.patch(configuration.id, {
          expectedVersion: 2,
          character: reference(character),
          configuration: {
            ...v2,
            version: 3,
            catalog: { ...v2.catalog, contentHash: `sha256:${'8'.repeat(64)}` },
          },
        }),
      ).rejects.toThrow('identity cannot change');
      await expect(skills.revision(first.latest)).resolves.toEqual(first.snapshot);
    } finally {
      input.store.close();
    }
  });

  it('keeps a saved V2 loadout bound to its exact acquisition revision after head drift', async () => {
    const input = await fixture();
    try {
      const { store, skills, character, configuration, catalogRecord } = input,
        acquisitions = new SkillAcquisitionStore(store),
        acquisition = await acquisitionFixture(store, input, 'acquisition.exact-revision'),
        loadout = await skills.create({
          character: reference(character),
          configuration: {
            schemaVersion: 2,
            id: configuration.id,
            version: 1,
            catalog: catalogRecord.reference,
            acquisition: acquisition.latest,
            enabledNodeIds: configuration.enabledNodeIds,
          },
        }),
        receipt = await skillBattleReceipt(loadout.snapshot);

      const advanced = await acquisitions.patch(acquisition.id, {
        expectedVersion: 1,
        selection: {
          schemaVersion: 1,
          id: acquisition.id,
          version: 2,
          character: reference(character),
          catalog: catalogRecord.reference,
          learnedNodeIds: acquisition.snapshot.learnedNodeIds,
        },
      });
      expect(advanced.latest).not.toEqual(acquisition.latest);

      const persisted = await skills.revision(loadout.latest);
      expect(persisted).toEqual(loadout.snapshot);
      expect(persisted.configuration).toMatchObject({ acquisition: acquisition.latest });
      expect(persisted.resolved).toMatchObject({ acquisition: acquisition.latest });
      expect(persisted.contentHash).toBe(loadout.latest.contentHash);
      await expect(skillBattleReceipt(persisted)).resolves.toEqual(receipt);
      const participants = structuredClone(input.manifest.participants),
        participantIndex = participants.findIndex(
          ({ character: participant }) => participant.id === character.id,
        );
      if (participantIndex < 0) throw new Error('Fixture character is not a participant');
      participants[participantIndex] = {
        ...participants[participantIndex]!,
        skillLoadout: receipt,
      };
      const prepared = await store.prepareSpec({
        seed: input.manifest.seed,
        participants,
        ruleset: input.manifest.ruleset,
        scenario: input.manifest.scenario,
      });
      await expect(runBattle(prepared.manifest)).resolves.toMatchObject({
        records: expect.any(Array),
      });
      await expect(skills.head(configuration.id)).resolves.toMatchObject({
        latest: loadout.latest,
        snapshot: {
          contentHash: loadout.latest.contentHash,
          configuration: { acquisition: acquisition.latest },
          resolved: { acquisition: acquisition.latest },
        },
      });
    } finally {
      input.store.close();
    }
  });

  it('rejects augment trigger and ability identity conflicts before saving', async () => {
    await expect(invalidAugment('id')).rejects.toThrow('preserve ability identity');
    await expect(invalidAugment('trigger')).rejects.toThrow('preserve ability trigger');
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
