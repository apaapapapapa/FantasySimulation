import { afterEach, describe, expect, it } from 'vite-plus/test';
import { parseJson, revisionReference, RevisionSchema } from '@fantasy/domain';
import { createApp } from '../http/app.ts';
import { SkillStore } from './skill-store.ts';
import { openStore, readSampleRevisions, type Store } from './store.ts';
import { seedStartupData } from './startup-data.ts';
import {
  STARTUP_SKILL_ABILITY_IDS,
  inspectStartupSkillCatalog,
  readStartupSkillCatalog,
} from './startup-skill-catalog.ts';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('production startup skill catalog', () => {
  it('keeps exactly one six-dan executable branch and marks every other coordinate draft', () => {
    const revisions = readSampleRevisions(),
      catalog = readStartupSkillCatalog(revisions),
      release = inspectStartupSkillCatalog(catalog, revisions),
      abilities = new Map(
        parseJson(RevisionSchema.array(), revisions)
          .filter((revision) => revision.kind === 'ability')
          .map((revision) => [revision.id, revision]),
      ),
      available = catalog.nodes.filter((node) => node.lifecycle === 'available'),
      drafts = catalog.nodes.filter((node) => node.lifecycle === 'draft');

    expect(catalog.nodes).toHaveLength(1_152);
    expect(available.map((node) => node.coordinate)).toEqual(
      [1, 2, 3, 4, 5, 6].map((dan) => ({ path: 'sword', zodiac: 'rat', dan })),
    );
    expect(drafts).toHaveLength(1_146);
    expect(drafts.every((node) => !node.resolution.length && !node.fixtureIds.length)).toBe(true);
    expect(available.map((node) => node.prerequisites)).toEqual([
      [],
      ['skill.sword.rat.1'],
      ['skill.sword.rat.2'],
      ['skill.sword.rat.3'],
      ['skill.sword.rat.4'],
      ['skill.sword.rat.5'],
    ]);
    expect(available.map((node) => node.deepening.kind)).toEqual([
      'foundation',
      'conditional-effect',
      'combination',
      'tactical-mode',
      'specialization',
      'ultimate-tradeoff',
    ]);
    const resolvedIds = available.map((node) => {
      const resolution = node.resolution[0]!;
      expect(resolution.kind).toBe('active-ability');
      if (resolution.kind !== 'active-ability') throw new Error('Expected active ability');
      const ability = abilities.get(resolution.ability.id);
      expect(ability).toMatchObject({
        kind: 'ability',
        contentHash: resolution.ability.contentHash,
      });
      if (ability?.kind !== 'ability') throw new Error('Missing selected ability');
      expect(ability.definition.trigger).toBe('action');
      return ability.id;
    });
    expect(resolvedIds).toEqual(STARTUP_SKILL_ABILITY_IDS);
    expect(new Set(resolvedIds).size).toBe(6);
    expect(release).toMatchObject({
      lifecycle: { available: 6, draft: 1_146, implemented: 0, retired: 0 },
      available: 6,
      verified: 6,
      releaseReady: false,
      issues: [],
    });

    const changed = structuredClone(parseJson(RevisionSchema.array(), revisions)),
      sword = changed.find((revision) => revision.kind === 'ability' && revision.id === 'sword');
    if (!sword) throw new Error('Missing sword mutation target');
    sword.contentHash = `sha256:${'0'.repeat(64)}`;
    expect(() => readStartupSkillCatalog(changed)).toThrow('Changed startup skill ability: sword');
  });

  it('seeds the catalog idempotently before the API serves it', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const first = await seedStartupData(store),
      second = await seedStartupData(store);
    expect(second.skillCatalog.reference).toEqual(first.skillCatalog.reference);
    expect(store.db.prepare('SELECT count(*) count FROM skill_catalog_revisions').get()).toEqual({
      count: 1,
    });
    const changed = structuredClone(first.skillCatalog.catalog);
    changed.nodes[0]!.name = 'Changed immutable startup node';
    await expect(new SkillStore(store).seedCatalog(changed)).rejects.toMatchObject({
      code: 'conflict',
    });

    const app = createApp(store);
    stores.pop();
    const response = await app.inject('/api/skill-catalogs/skill-catalog-v1/1');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reference: first.skillCatalog.reference,
      catalog: { id: 'skill-catalog-v1', revision: 1 },
    });
    expect(response.json().catalog.nodes).toHaveLength(1_152);
    await app.close();
  });

  it('resolves sixth dan through all six production prerequisites', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const seeded = await seedStartupData(store),
      revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
      character = revisions.find(
        (revision) => revision.kind === 'character' && revision.id === 'stage-vanguard-v1',
      );
    if (character?.kind !== 'character') throw new Error('Missing stage vanguard fixture');
    const nodeIds = [1, 2, 3, 4, 5, 6].map((dan) => `skill.sword.rat.${dan}`),
      created = await new SkillStore(store).create({
        character: revisionReference(character),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.startup.sword.rat',
          version: 1,
          catalog: seeded.skillCatalog.reference,
          eligibilityNodeIds: nodeIds,
          learnedNodeIds: nodeIds,
          enabledNodeIds: [nodeIds.at(-1)],
        },
      });
    expect(created.snapshot.resolved).toMatchObject({
      explicitlyEnabledNodeIds: ['skill.sword.rat.6'],
      resolvedNodeIds: nodeIds,
    });
    expect(
      created.snapshot.resolved.nodeResolutions.map(({ resolution }) => {
        const selected = resolution[0]!;
        if (selected.kind !== 'active-ability') throw new Error('Expected active ability');
        return selected.ability.id;
      }),
    ).toEqual(STARTUP_SKILL_ABILITY_IDS);
  });
});
