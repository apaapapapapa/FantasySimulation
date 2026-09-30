import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  ReplayState,
  parseJson,
  replayContext,
  revisionReference,
  skillBattleReceipt,
  skillCatalogDigest,
  RevisionSchema,
  type Revision,
} from '@fantasy/domain';
import { ManifestBuilder, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { createApp } from '../http/app.ts';
import { SkillStore } from './skill-store.ts';
import { openStore, readSampleRevisions, type Store } from './store.ts';
import { seedStartupData } from './startup-data.ts';
import {
  STARTUP_SKILL_ABILITY_IDS,
  inspectIntegratedStartupSkillCatalog,
  inspectStartupSkillCatalog,
  readIntegratedStartupSkillCatalog,
  readPreviousIntegratedStartupSkillCatalog,
  readStartupSkillCatalog,
} from './startup-skill-catalog.ts';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function runAndReplay(
  manifest: Awaited<ReturnType<typeof catalogManifest>>,
  ability: Extract<Revision, { kind: 'ability' }>,
) {
  const battle = await ManifestBuilder.from([...manifest.revisions, ability]).build({
      seed: manifest.seed,
      participants: manifest.participants,
      ruleset: manifest.ruleset,
      scenario: manifest.scenario,
    }),
    run = await runBattle(battle.manifest),
    context = await replayContext(battle.manifest, run.result.simulationHash),
    restored = new ReplayState(context);
  for (const record of run.records) restored.apply(record);
  return { battle, run, context, restored };
}

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
      count: 3,
    });
    const changed = structuredClone(first.skillCatalog.catalog);
    changed.nodes[0]!.name = 'Changed immutable startup node';
    await expect(new SkillStore(store).seedCatalog(changed)).rejects.toMatchObject({
      code: 'conflict',
    });

    const app = createApp(store);
    stores.pop();
    const response = await app.inject('/api/skill-catalogs/skill-catalog-v1/4');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reference: first.skillCatalog.reference,
      catalog: { id: 'skill-catalog-v1', revision: 4 },
    });
    expect(response.json().catalog.nodes).toHaveLength(1_152);
    const previous = await app.inject('/api/skill-catalogs/skill-catalog-v1/3');
    expect(previous.statusCode).toBe(200);
    expect(previous.json().catalog).toMatchObject({ id: 'skill-catalog-v1', revision: 3 });
    const legacy = await app.inject('/api/skill-catalogs/skill-catalog-v1/1');
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().catalog).toMatchObject({ id: 'skill-catalog-v1', revision: 1 });
    await app.close();
  });

  it('preserves existing integrated v2 and immutable v3 when seeding v4', async () => {
    const store = openStore(':memory:'),
      revisions = readSampleRevisions();
    stores.push(store);
    await store.seedRevisions(revisions);
    const skills = new SkillStore(store),
      historicalV2 = readPreviousIntegratedStartupSkillCatalog(revisions);
    historicalV2.revision = 2;
    historicalV2.nodes.find(({ id }) => id === 'skill.shield.ox.1')!.name =
      'Previously stored shield revision';
    const historicalV3Catalog = readPreviousIntegratedStartupSkillCatalog(revisions);
    expect(await skillCatalogDigest(historicalV3Catalog)).toBe(
      'sha256:7567e53cc5639ce9fad3578d81331e8804880758626e7a5cd3bbc755cdf67026',
    );
    const previousV2 = await skills.seedCatalog(historicalV2),
      historicalV3 = await skills.seedCatalog(historicalV3Catalog),
      seeded = await seedStartupData(store);

    expect(seeded.skillCatalog.reference).toMatchObject({
      id: 'skill-catalog-v1',
      revision: 4,
    });
    expect(await skills.catalog('skill-catalog-v1', 2)).toEqual(previousV2);
    expect(await skills.catalog('skill-catalog-v1', 3)).toEqual(historicalV3);
    expect(store.db.prepare('SELECT count(*) count FROM skill_catalog_revisions').get()).toEqual({
      count: 4,
    });
  });

  it('integrates fourteen authored paths while keeping unfinished coordinates unavailable', () => {
    const revisions = readSampleRevisions(),
      catalog = readIntegratedStartupSkillCatalog(revisions),
      release = inspectIntegratedStartupSkillCatalog(catalog, revisions),
      available = catalog.nodes.filter(({ lifecycle }) => lifecycle === 'available');

    expect(catalog).toMatchObject({ id: 'skill-catalog-v1', revision: 4 });
    expect(catalog.nodes).toHaveLength(1_152);
    expect(release).toEqual({
      lifecycle: { available: 28, implemented: 3, draft: 1_121, retired: 0 },
      available: 28,
      verified: 28,
      releaseReady: false,
      issues: [],
    });
    expect(available.filter(({ coordinate }) => coordinate.path === 'sword')).toHaveLength(6);
    expect(available.filter(({ coordinate }) => coordinate.path === 'spear')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'shield')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'aikido')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'shinto')).toHaveLength(4);
    expect(available.filter(({ coordinate }) => coordinate.path === 'renki')).toHaveLength(4);
    expect(available.filter(({ coordinate }) => coordinate.path === 'magic')).toHaveLength(11);
    expect(
      catalog.nodes
        .filter(({ coordinate }) => ['illusion-curse', 'summoning'].includes(coordinate.path))
        .every(
          ({ lifecycle, resolution, fixtureIds }) =>
            lifecycle === 'draft' && !resolution.length && !fixtureIds.length,
        ),
    ).toBe(true);
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

  it('carries the existing spear selection through saved loadout, battle AI, and replay', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const seeded = await seedStartupData(store),
      revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
      character = revisions.find(
        (revision) => revision.kind === 'character' && revision.id === 'swordsman',
      ),
      spear = revisions.find((revision) => revision.kind === 'ability' && revision.id === 'spear');
    if (character?.kind !== 'character') throw new Error('Missing swordsman fixture');
    if (spear?.kind !== 'ability') throw new Error('Missing spear fixture');

    const nodeId = 'skill.spear.rat.1',
      created = await new SkillStore(store).create({
        character: revisionReference(character),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.integrated.spear',
          version: 1,
          catalog: seeded.skillCatalog.reference,
          eligibilityNodeIds: [nodeId],
          learnedNodeIds: [nodeId],
          enabledNodeIds: [nodeId],
        },
      }),
      manifest = await catalogManifest('swordsman', 'swordsman', 'flat', 200, 42);
    manifest.participants[0]!.skillLoadout = await skillBattleReceipt(created.snapshot);
    const { battle, run, context, restored } = await runAndReplay(manifest, spear);

    expect(created.snapshot.resolved.resolvedNodeIds).toEqual([nodeId]);
    expect(battle.manifest.participants[0]!.skillLoadout?.catalog).toEqual(
      seeded.skillCatalog.reference,
    );
    expect(context.manifest.participants[0]!.skillLoadout?.resolvedNodeIds).toEqual([nodeId]);
    expect(
      run.records.some(
        (record) =>
          'events' in record &&
          record.events.some(
            (event) =>
              event.kind === 'launch' && event.actorId === 'left' && event.abilityId === 'spear',
          ),
      ),
    ).toBe(true);
    expect(restored).toMatchObject({ ended: true, step: run.result.steps });
  });

  it('carries the aikido parry selection through save, reload, battle AI, and replay', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const seeded = await seedStartupData(store),
      revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
      character = revisions.find(
        (revision) => revision.kind === 'character' && revision.id === 'posture-duelist-v1',
      ),
      parry = revisions.find(
        (revision) => revision.kind === 'ability' && revision.id === 'parry-v1',
      );
    if (character?.kind !== 'character') throw new Error('Missing posture duelist fixture');
    if (parry?.kind !== 'ability') throw new Error('Missing parry fixture');

    const nodeId = 'skill.aikido.dog.1',
      skills = new SkillStore(store),
      created = await skills.create({
        character: revisionReference(character),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.integrated.aikido-parry',
          version: 1,
          catalog: seeded.skillCatalog.reference,
          eligibilityNodeIds: [nodeId],
          learnedNodeIds: [nodeId],
          enabledNodeIds: [nodeId],
        },
      }),
      reloaded = await skills.revision(created.latest),
      manifest = await catalogManifest(
        'posture-duelist-v1',
        'phoenix-duelist-v1',
        'flat',
        800,
        228,
      );
    manifest.participants[0]!.skillLoadout = await skillBattleReceipt(reloaded);
    const { run, context, restored } = await runAndReplay(manifest, parry);

    expect(reloaded.resolved).toMatchObject({
      explicitlyEnabledNodeIds: [nodeId],
      resolvedNodeIds: [nodeId],
      nodeResolutions: [
        {
          nodeId,
          resolution: [{ kind: 'passive-ability', ability: revisionReference(parry) }],
        },
      ],
    });
    expect(context.manifest.participants[0]!.skillLoadout).toMatchObject({
      catalog: seeded.skillCatalog.reference,
      resolvedNodeIds: [nodeId],
    });
    expect(
      run.records.some(
        (record) =>
          'events' in record &&
          record.events.some(
            (event) =>
              event.kind === 'reaction' &&
              event.ruleId === 'reaction.activated' &&
              event.actorId === 'left' &&
              event.abilityId === parry.id,
          ),
      ),
    ).toBe(true);
    expect(restored).toMatchObject({ ended: true, step: run.result.steps });
  });
});
