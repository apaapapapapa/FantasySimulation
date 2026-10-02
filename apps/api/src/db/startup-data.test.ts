import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  ReplayState,
  canonicalJson,
  parseJson,
  replayContext,
  revisionReference,
  skillBattleReceipt,
  skillCatalogDigest,
  nextRandom,
  RevisionSchema,
  type Revision,
  type SkillCatalog,
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
  readIntegratedStartupSkillCatalogV2,
  readIntegratedStartupSkillCatalogV3,
  readIntegratedStartupSkillCatalogV5,
  readIntegratedStartupSkillCatalogV6,
  readIntegratedStartupSkillCatalogV7,
  readPreviousIntegratedStartupSkillCatalog,
  readStartupSkillCatalog,
} from './startup-skill-catalog.ts';
import summoningFixture from '../../../../packages/engine/fixtures/spatial/summoning-rat-dan1-runtime-v1.json' with { type: 'json' };

const stores: Store[] = [];
const historicalCatalogSignatures = {
  2: {
    digest: 'sha256:5537f45d9be2b1d8d6dbe9d8099db2388f30c6c772694aee693547d2ebad5c69',
    canonicalBytes: 777_368,
    lifecycle: { available: 26, implemented: 4, draft: 1_122, retired: 0 },
  },
  3: {
    digest: 'sha256:7567e53cc5639ce9fad3578d81331e8804880758626e7a5cd3bbc755cdf67026',
    canonicalBytes: 777_476,
    lifecycle: { available: 27, implemented: 3, draft: 1_122, retired: 0 },
  },
  4: {
    digest: 'sha256:3d6df8e9f07c2bfa492fbfdab80b5acb8937d168826331c6bbdd1f33179ef968',
    canonicalBytes: 777_669,
    lifecycle: { available: 28, implemented: 3, draft: 1_121, retired: 0 },
  },
  5: {
    digest: 'sha256:153c28b31dc5dceb759210ed23bd80d38d3d6a2573bfb7f40feabf273bbc3e47',
    canonicalBytes: 777_871,
    lifecycle: { available: 29, implemented: 3, draft: 1_120, retired: 0 },
  },
  6: {
    digest: 'sha256:b479659ce5d1cef32818323185b09a1484b9868bbc76d20c8f16d9f7e150afaf',
    canonicalBytes: 777_861,
    lifecycle: { available: 30, implemented: 2, draft: 1_120, retired: 0 },
  },
  7: {
    digest: 'sha256:158f5c3ba6dbdc1b3d55ed411c60bd79a5a9252081a11a2c5082d1ae0cb78e6f',
    canonicalBytes: 778_186,
    lifecycle: { available: 31, implemented: 2, draft: 1_119, retired: 0 },
  },
} as const;
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function catalogHistorySignature(value: SkillCatalog) {
  return {
    digest: await skillCatalogDigest(value),
    canonicalBytes: new TextEncoder().encode(canonicalJson(value)).byteLength,
    lifecycle: Object.fromEntries(
      ['available', 'implemented', 'draft', 'retired'].map((lifecycle) => [
        lifecycle,
        value.nodes.filter((node) => node.lifecycle === lifecycle).length,
      ]),
    ),
  };
}

const changedNodeIds = (left: SkillCatalog, right: SkillCatalog) =>
  left.nodes
    .filter((node, index) => canonicalJson(node) !== canonicalJson(right.nodes[index]))
    .map(({ id }) => id);

async function runAndReplay(
  manifest: Awaited<ReturnType<typeof catalogManifest>>,
  ...abilities: Extract<Revision, { kind: 'ability' }>[]
) {
  const revisions = [...manifest.revisions];
  for (const ability of abilities)
    if (
      !revisions.some(
        (revision) =>
          revision.kind === ability.kind &&
          revision.id === ability.id &&
          revision.revision === ability.revision,
      )
    )
      revisions.push(ability);
  const battle = await ManifestBuilder.from(revisions).build({
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

async function seededCharacterAbility(characterId: string, abilityId: string) {
  const store = openStore(':memory:');
  stores.push(store);
  const seeded = await seedStartupData(store),
    revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
    character = revisions.find(
      (revision) => revision.kind === 'character' && revision.id === characterId,
    ),
    ability = revisions.find(
      (revision) => revision.kind === 'ability' && revision.id === abilityId,
    );
  if (character?.kind !== 'character') throw new Error(`Missing ${characterId} fixture`);
  if (ability?.kind !== 'ability') throw new Error(`Missing ${abilityId} fixture`);
  return { store, seeded, revisions, character, ability };
}

async function savedSkillBattleFixture(
  seededFixture: Awaited<ReturnType<typeof seededCharacterAbility>>,
  nodeId: string,
  id: string,
) {
  const skills = new SkillStore(seededFixture.store),
    created = await skills.create({
      character: revisionReference(seededFixture.character),
      configuration: {
        schemaVersion: 1,
        id,
        version: 1,
        catalog: seededFixture.seeded.skillCatalog.reference,
        eligibilityNodeIds: [nodeId],
        learnedNodeIds: [nodeId],
        enabledNodeIds: [nodeId],
      },
    }),
    reloaded = await skills.revision(created.latest);
  return { reloaded, receipt: await skillBattleReceipt(reloaded) };
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
      count: 8,
    });
    const changed = structuredClone(first.skillCatalog.catalog);
    changed.nodes[0]!.name = 'Changed immutable startup node';
    await expect(new SkillStore(store).seedCatalog(changed)).rejects.toMatchObject({
      code: 'conflict',
    });

    const app = createApp(store);
    stores.pop();
    const response = await app.inject('/api/skill-catalogs/skill-catalog-v1/8');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reference: first.skillCatalog.reference,
      catalog: { id: 'skill-catalog-v1', revision: 8 },
    });
    expect(response.json().catalog.nodes).toHaveLength(1_152);
    for (const revision of [2, 3, 4, 5, 6, 7]) {
      const previous = await app.inject(`/api/skill-catalogs/skill-catalog-v1/${revision}`);
      expect(previous.statusCode).toBe(200);
      expect(previous.json()).toMatchObject({
        reference: {
          id: 'skill-catalog-v1',
          revision,
          contentHash:
            historicalCatalogSignatures[revision as keyof typeof historicalCatalogSignatures]
              .digest,
        },
        catalog: { id: 'skill-catalog-v1', revision },
      });
    }
    const legacy = await app.inject('/api/skill-catalogs/skill-catalog-v1/1');
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().catalog).toMatchObject({ id: 'skill-catalog-v1', revision: 1 });
    await app.close();
  });

  it('preserves immutable v2 through v7 before seeding v8', async () => {
    const store = openStore(':memory:'),
      revisions = readSampleRevisions();
    stores.push(store);
    await store.seedRevisions(revisions);
    const skills = new SkillStore(store),
      historicalV2Catalog = readIntegratedStartupSkillCatalogV2(revisions),
      historicalV3Catalog = readIntegratedStartupSkillCatalogV3(revisions),
      historicalV4Catalog = readPreviousIntegratedStartupSkillCatalog(revisions),
      historicalV5Catalog = readIntegratedStartupSkillCatalogV5(revisions),
      historicalV6Catalog = readIntegratedStartupSkillCatalogV6(revisions),
      historicalV7Catalog = readIntegratedStartupSkillCatalogV7(revisions);
    expect(await catalogHistorySignature(historicalV2Catalog)).toEqual(
      historicalCatalogSignatures[2],
    );
    expect(historicalV2Catalog.nodes.find(({ id }) => id === 'skill.shield.ox.1')).toMatchObject({
      lifecycle: 'implemented',
      resolution: [
        {
          kind: 'active-ability',
          ability: {
            id: 'guard',
            revision: 1,
            contentHash: 'sha256:f05415d544efcfcc0e4fa8f2698d2033d064346bd071563ca8e6dd9de3cdb769',
          },
        },
      ],
      fixtureIds: ['effects-order-free-shield'],
    });
    expect(await catalogHistorySignature(historicalV3Catalog)).toEqual(
      historicalCatalogSignatures[3],
    );
    expect(await catalogHistorySignature(historicalV4Catalog)).toEqual(
      historicalCatalogSignatures[4],
    );
    expect(await catalogHistorySignature(historicalV5Catalog)).toEqual(
      historicalCatalogSignatures[5],
    );
    expect(await catalogHistorySignature(historicalV6Catalog)).toEqual(
      historicalCatalogSignatures[6],
    );
    expect(await catalogHistorySignature(historicalV7Catalog)).toEqual(
      historicalCatalogSignatures[7],
    );
    const previousV2 = await skills.seedCatalog(historicalV2Catalog),
      previousV3 = await skills.seedCatalog(historicalV3Catalog),
      previousV4 = await skills.seedCatalog(historicalV4Catalog),
      previousV5 = await skills.seedCatalog(historicalV5Catalog),
      previousV6 = await skills.seedCatalog(historicalV6Catalog),
      previousV7 = await skills.seedCatalog(historicalV7Catalog),
      seeded = await seedStartupData(store);

    expect(seeded.skillCatalog.reference).toMatchObject({
      id: 'skill-catalog-v1',
      revision: 8,
    });
    expect(await skills.catalog('skill-catalog-v1', 2)).toEqual(previousV2);
    expect(await skills.catalog('skill-catalog-v1', 3)).toEqual(previousV3);
    expect(await skills.catalog('skill-catalog-v1', 4)).toEqual(previousV4);
    expect(await skills.catalog('skill-catalog-v1', 5)).toEqual(previousV5);
    expect(await skills.catalog('skill-catalog-v1', 6)).toEqual(previousV6);
    expect(await skills.catalog('skill-catalog-v1', 7)).toEqual(previousV7);
    expect(store.db.prepare('SELECT count(*) count FROM skill_catalog_revisions').get()).toEqual({
      count: 8,
    });
    expect(
      await catalogHistorySignature((await skills.catalog('skill-catalog-v1', 2))!.catalog),
    ).toEqual(historicalCatalogSignatures[2]);
    expect(
      await catalogHistorySignature((await skills.catalog('skill-catalog-v1', 5))!.catalog),
    ).toEqual(historicalCatalogSignatures[5]);
    expect(
      await catalogHistorySignature((await skills.catalog('skill-catalog-v1', 6))!.catalog),
    ).toEqual(historicalCatalogSignatures[6]);
    expect(changedNodeIds(historicalV2Catalog, historicalV3Catalog)).toEqual(['skill.shield.ox.1']);
    expect(changedNodeIds(historicalV3Catalog, historicalV4Catalog)).toEqual([
      'skill.aikido.dog.1',
    ]);
    expect(changedNodeIds(historicalV4Catalog, historicalV5Catalog)).toEqual([
      'skill.magic.rooster.2',
    ]);
    expect(changedNodeIds(historicalV5Catalog, historicalV6Catalog)).toEqual([
      'skill.archery.rat.1',
    ]);
    expect(changedNodeIds(historicalV6Catalog, seeded.skillCatalog.catalog)).toEqual([
      'skill.illusion-curse.rabbit.1',
      'skill.summoning.rat.1',
    ]);
    expect(changedNodeIds(historicalV6Catalog, historicalV7Catalog)).toEqual([
      'skill.illusion-curse.rabbit.1',
    ]);
    expect(changedNodeIds(historicalV7Catalog, seeded.skillCatalog.catalog)).toEqual([
      'skill.summoning.rat.1',
    ]);
    const lifecycle = (revision: number, nodeId: string) =>
      skills
        .catalog('skill-catalog-v1', revision)
        .then((record) => record?.catalog.nodes.find(({ id }) => id === nodeId)?.lifecycle);
    await expect(lifecycle(2, 'skill.shield.ox.1')).resolves.toBe('implemented');
    await expect(lifecycle(3, 'skill.shield.ox.1')).resolves.toBe('available');
    await expect(lifecycle(3, 'skill.aikido.dog.1')).resolves.toBe('draft');
    await expect(lifecycle(4, 'skill.aikido.dog.1')).resolves.toBe('available');
    await expect(lifecycle(4, 'skill.magic.rooster.2')).resolves.toBe('draft');
    await expect(lifecycle(5, 'skill.magic.rooster.2')).resolves.toBe('available');
    await expect(lifecycle(5, 'skill.archery.rat.1')).resolves.toBe('implemented');
    await expect(lifecycle(6, 'skill.archery.rat.1')).resolves.toBe('available');
    await expect(lifecycle(6, 'skill.illusion-curse.rabbit.1')).resolves.toBe('draft');
    await expect(lifecycle(7, 'skill.illusion-curse.rabbit.1')).resolves.toBe('available');
    await expect(lifecycle(7, 'skill.summoning.rat.1')).resolves.toBe('draft');
    await expect(lifecycle(8, 'skill.summoning.rat.1')).resolves.toBe('available');
  });

  it('integrates fourteen authored paths while keeping unfinished coordinates unavailable', () => {
    const revisions = readSampleRevisions(),
      catalog = readIntegratedStartupSkillCatalog(revisions),
      release = inspectIntegratedStartupSkillCatalog(catalog, revisions),
      available = catalog.nodes.filter(({ lifecycle }) => lifecycle === 'available');

    expect(catalog).toMatchObject({ id: 'skill-catalog-v1', revision: 8 });
    expect(catalog.nodes).toHaveLength(1_152);
    expect(new Set(catalog.nodes.map(({ id }) => id))).toHaveLength(1_152);
    expect(release).toEqual({
      lifecycle: { available: 32, implemented: 2, draft: 1_118, retired: 0 },
      available: 32,
      verified: 32,
      releaseReady: false,
      issues: [],
    });
    expect(available.filter(({ coordinate }) => coordinate.path === 'sword')).toHaveLength(6);
    expect(available.filter(({ coordinate }) => coordinate.path === 'archery')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'spear')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'shield')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'aikido')).toHaveLength(1);
    expect(available.filter(({ coordinate }) => coordinate.path === 'shinto')).toHaveLength(4);
    expect(available.filter(({ coordinate }) => coordinate.path === 'renki')).toHaveLength(4);
    expect(available.filter(({ coordinate }) => coordinate.path === 'magic')).toHaveLength(12);
    expect(available.filter(({ coordinate }) => coordinate.path === 'illusion-curse')).toHaveLength(
      1,
    );
    expect(
      [5, 6].map((dan) =>
        catalog.nodes.find(({ id }) => id === `skill.illusion-curse.rabbit.${dan}`),
      ),
    ).toEqual([
      expect.objectContaining({ lifecycle: 'draft', resolution: [], fixtureIds: [] }),
      expect.objectContaining({ lifecycle: 'draft', resolution: [], fixtureIds: [] }),
    ]);
    const summoning = catalog.nodes.filter(({ coordinate }) => coordinate.path === 'summoning');
    expect(summoning.filter(({ id }) => id === 'skill.summoning.rat.1')).toEqual([
      expect.objectContaining({
        lifecycle: 'available',
        resolution: [
          {
            kind: 'active-ability',
            ability: {
              id: 'scout-rat-v1',
              revision: 1,
              contentHash:
                'sha256:c137e74851756fbdd5d8aefcdaecd325347758ad1627c1bc7f7a21b673687927',
            },
          },
        ],
        fixtureIds: ['fixture.skill.summoning.rat.1.runtime.v1'],
      }),
    ]);
    expect(
      summoning.filter(({ lifecycle }) => lifecycle === 'available').map(({ id }) => id),
    ).toEqual(['skill.summoning.rat.1']);
    expect(
      summoning
        .filter(({ id }) => id !== 'skill.summoning.rat.1')
        .every(
          ({ lifecycle, resolution, fixtureIds }) =>
            lifecycle === 'draft' && !resolution.length && !fixtureIds.length,
        ),
    ).toBe(true);
    expect(
      [5, 6].map((dan) => catalog.nodes.find(({ id }) => id === `skill.summoning.rat.${dan}`)),
    ).toEqual([
      expect.objectContaining({ lifecycle: 'draft', resolution: [], fixtureIds: [] }),
      expect.objectContaining({ lifecycle: 'draft', resolution: [], fixtureIds: [] }),
    ]);
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

  it('runs fixture.skill.archery.rat.1.runtime only after saved selection and replays its damage', async () => {
    const {
      store,
      seeded,
      revisions,
      character,
      ability: arrow,
    } = await seededCharacterAbility('swordsman', 'arrow');
    const policy = revisions.find(
      (revision) =>
        revision.kind === 'policy' &&
        revision.id === character.definition.policy.id &&
        revision.revision === character.definition.policy.revision,
    );
    if (policy?.kind !== 'policy') throw new Error('Missing swordsman policy fixture');
    expect(character.definition.abilities.map(({ id }) => id)).not.toContain(arrow.id);
    expect(policy.definition.priorities.map(({ abilityId }) => abilityId)).not.toContain(arrow.id);

    const negativeManifest = await catalogManifest('swordsman', 'swordsman', 'flat', 400, 228),
      negative = await runAndReplay(negativeManifest, arrow),
      negativeEvents = negative.run.records.flatMap((record) =>
        'events' in record ? record.events : [],
      );
    expect(negative.context.actors[0]!.abilities.map(({ id }) => id)).not.toContain(arrow.id);
    expect(
      negativeEvents.some(
        (event) =>
          event.kind === 'launch' && event.actorId === 'left' && event.abilityId === arrow.id,
      ),
    ).toBe(false);
    expect(
      negativeEvents.some(
        (event) =>
          event.kind === 'damage' && event.actorId === 'left' && event.abilityId === arrow.id,
      ),
    ).toBe(false);

    const nodeId = 'skill.archery.rat.1',
      skills = new SkillStore(store),
      created = await skills.create({
        character: revisionReference(character),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.integrated.archery-rat-foundation',
          version: 1,
          catalog: seeded.skillCatalog.reference,
          eligibilityNodeIds: [nodeId],
          learnedNodeIds: [nodeId],
          enabledNodeIds: [nodeId],
        },
      }),
      reloaded = await skills.revision(created.latest),
      manifest = await catalogManifest('swordsman', 'swordsman', 'flat', 400, 228);
    manifest.participants[0]!.skillLoadout = await skillBattleReceipt(reloaded);
    const actual = await runAndReplay(manifest, arrow),
      actualEvents = actual.run.records.flatMap((record) =>
        'events' in record ? record.events : [],
      ),
      arrowLaunches = actualEvents.filter(
        (event) =>
          event.kind === 'launch' && event.actorId === 'left' && event.abilityId === arrow.id,
      ),
      arrowDamage = actualEvents.filter(
        (event) =>
          event.kind === 'damage' && event.actorId === 'left' && event.abilityId === arrow.id,
      );

    expect(reloaded.resolved).toMatchObject({
      explicitlyEnabledNodeIds: [nodeId],
      resolvedNodeIds: [nodeId],
      nodeResolutions: [
        {
          nodeId,
          resolution: [{ kind: 'active-ability', ability: revisionReference(arrow) }],
        },
      ],
    });
    expect(actual.context.manifest.participants[0]!.skillLoadout).toMatchObject({
      catalog: seeded.skillCatalog.reference,
      resolvedNodeIds: [nodeId],
    });
    expect(actual.context.actors[0]!.abilities.map(({ id }) => id)).toContain(arrow.id);
    expect(arrowLaunches.length).toBeGreaterThan(0);
    expect(arrowDamage.length).toBeGreaterThan(0);
    const replayedRight = actual.restored
      .checkpoint()
      .state!.actors.find(({ id }) => id === 'right')!;
    expect(replayedRight.resources.hp).toBeLessThan(100);
    expect(replayedRight.resources.hp).toBe(
      100 -
        actualEvents
          .filter((event) => event.kind === 'damage' && event.targetId === 'right')
          .reduce((total, event) => total + (event.amount ?? 0), 0),
    );
    expect(actual.restored).toMatchObject({ ended: true, step: actual.run.result.steps });

    const archeryRat = seeded.skillCatalog.catalog.nodes.filter(
      ({ coordinate }) => coordinate.path === 'archery' && coordinate.zodiac === 'rat',
    );
    expect(archeryRat[0]).toMatchObject({
      id: nodeId,
      lifecycle: 'available',
      deepening: { retainsLowerUse: true },
    });
    expect(archeryRat.slice(4)).toHaveLength(2);
    expect(
      archeryRat
        .slice(4)
        .every(
          ({ lifecycle, deepening }) =>
            lifecycle === 'draft' &&
            deepening.retainsLowerUse &&
            Boolean(deepening.conditionOrTradeoff),
        ),
    ).toBe(true);
  });

  it('runs fixture.skill.summoning.rat.1.runtime.v1 from the saved production recipe', async () => {
    const {
      store,
      seeded,
      character,
      ability: summon,
    } = await seededCharacterAbility('swordsman', 'scout-rat-v1');
    expect(revisionReference(summon)).toEqual(summoningFixture.ability);
    expect(summon.definition.summon).toMatchObject({
      profile: summoningFixture.recipe.profile,
      hp: summoningFixture.recipe.hp,
      lifetimeSteps: summoningFixture.recipe.lifetimeSteps,
      upkeep: {
        mp: summoningFixture.recipe.upkeepMp,
        everySteps: summoningFixture.recipe.upkeepEverySteps,
      },
      commandCostMp: summoningFixture.recipe.commandCostMp,
      actionEverySteps: summoningFixture.recipe.actionEverySteps,
      damage: {
        amount: summoningFixture.recipe.damage,
        drainBps: summoningFixture.recipe.drainBps,
      },
    });

    const nodeId = summoningFixture.catalogNodeId,
      { reloaded, receipt } = await savedSkillBattleFixture(
        { store, seeded, revisions: [], character, ability: summon },
        nodeId,
        'loadout.integrated.summoning-rat-foundation',
      ),
      manifest = await catalogManifest(
        'swordsman',
        'swordsman',
        'flat',
        6000,
        228,
        summoningFixture.ruleset.id,
      );
    manifest.participants[0]!.skillLoadout = receipt;
    manifest.participants[1]!.skillLoadout = receipt;
    const actual = await runAndReplay(manifest, summon),
      events = actual.run.records.flatMap((record) => ('events' in record ? record.events : [])),
      commands = events.filter((event) => event.kind === 'dependent-command'),
      acts = events.filter((event) => event.kind === 'dependent-act'),
      spawned = actual.run.records.flatMap((record) =>
        'dependents' in record ? (record.dependents?.spawn ?? []) : [],
      );

    expect(reloaded.resolved.nodeResolutions).toEqual([
      {
        nodeId,
        resolution: [{ kind: 'active-ability', ability: summoningFixture.ability }],
      },
    ]);
    expect(actual.battle.manifest.schemaVersion).toBe(
      summoningFixture.expected.manifestSchemaVersion,
    );
    expect(actual.battle.manifest.ruleset).toEqual(summoningFixture.ruleset);
    expect(actual.battle.manifest.participants.map(({ skillLoadout }) => skillLoadout)).toEqual([
      receipt,
      receipt,
    ]);
    const initial = actual.run.records[0];
    if (initial?.kind !== 'initial') throw new Error('Missing summon initial record');
    expect(initial.requiredFeatures).toContain(summoningFixture.expected.requiredFeature);
    expect(spawned).toHaveLength(2);
    expect(
      spawned.every(
        ({ ownerId, hostileOwnerId, maxHp }) =>
          ownerId !== hostileOwnerId && maxHp === summoningFixture.recipe.hp,
      ),
    ).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
    expect(acts).toHaveLength(commands.length);
    const rng = new Map(spawned.map(({ id, rngState }) => [id, rngState]));
    let observedMultiple = false;
    for (const command of commands) {
      const observed = command.dependent?.observedTargetIds;
      const before = rng.get(command.entityId!);
      if (!observed?.length || before === undefined) throw new Error('Missing recorded target RNG');
      const roll = nextRandom(before);
      expect(command.targetId).toBe(observed[roll % observed.length]);
      expect(command.before?.mp).toBe(command.after?.mp);
      rng.set(command.entityId!, roll);
      observedMultiple ||= observed.length > 1;
      const act = acts.find((candidate) => candidate.parentEventId === command.id);
      expect(act).toMatchObject({
        actorId: command.actorId,
        entityId: command.entityId,
        targetId: command.targetId,
      });
      const damage = events.find(
        (candidate) =>
          candidate.kind === 'damage' &&
          candidate.parentEventId === act?.id &&
          candidate.targetId === command.targetId,
      );
      expect(damage).toMatchObject({
        amount: command.targetId?.startsWith('dependent.')
          ? summoningFixture.expected.dependentDamage
          : summoningFixture.expected.participantDamageAfterDefense,
      });
    }
    expect(observedMultiple).toBe(true);
    expect(
      events.some(
        (event) => event.kind === 'heal' && event.reason === 'same-wave-hp-loss-dependent-drain',
      ),
    ).toBe(false);
    expect(
      events.filter((event) => event.kind === 'dependent-despawn').map(({ reason }) => reason),
    ).toContain(summoningFixture.expected.despawnReason);
    expect(actual.restored.checkpoint().state?.dependents ?? []).toHaveLength(0);
  });

  it('runs the saved rabbit hologram recipe under an explicitly selected production ruleset', async () => {
    const {
      store,
      seeded,
      character,
      ability: hologram,
    } = await seededCharacterAbility('swordsman', 'side-step-image-v1');
    const nodeId = 'skill.illusion-curse.rabbit.1',
      { reloaded, receipt } = await savedSkillBattleFixture(
        { store, seeded, revisions: [], character, ability: hologram },
        nodeId,
        'loadout.integrated.illusion-curse-rabbit-foundation',
      ),
      manifest = await catalogManifest(
        'swordsman',
        'swordsman',
        'flat',
        6000,
        228,
        'standard-p6-group2-v1',
      );
    manifest.participants[0]!.skillLoadout = receipt;
    const { run, context, restored } = await runAndReplay(manifest, hologram),
      events = run.records.flatMap((record) => ('events' in record ? record.events : [])),
      lifecycle = events.filter(
        (event) =>
          event.kind === 'environmental-hologram' &&
          event.abilityId === hologram.id &&
          event.environmentalHologram,
      ),
      firstId = lifecycle[0]?.environmentalHologram?.id,
      first = lifecycle.filter((event) => event.environmentalHologram?.id === firstId);

    expect(reloaded.resolved).toMatchObject({
      explicitlyEnabledNodeIds: [nodeId],
      resolvedNodeIds: [nodeId],
      nodeResolutions: [
        {
          nodeId,
          resolution: [{ kind: 'active-ability', ability: revisionReference(hologram) }],
        },
      ],
    });
    expect(context.manifest.ruleset).toEqual({
      id: 'standard-p6-group2-v1',
      revision: 1,
      contentHash: 'sha256:7a29dffc918f926dfe030ea3ae9bf488d582abae743179cb60617cbd1c7016d3',
    });
    expect(first.map((event) => event.environmentalHologram!.transition)).toContain('activated');
    expect(restored.checkpoint().state!.actors).toHaveLength(2);
  });

  it('carries the existing spear selection through saved loadout, battle AI, and replay', async () => {
    const {
      store,
      seeded,
      character,
      ability: spear,
    } = await seededCharacterAbility('swordsman', 'spear');

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

  it('carries rooster dan two through save, reload, AI, battle and replay', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const seeded = await seedStartupData(store),
      revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
      character = revisions.find(
        (revision) => revision.kind === 'character' && revision.id === 'swordsman',
      ),
      reveal = revisions.find(
        (revision) => revision.kind === 'ability' && revision.id === 'reveal-fire',
      ),
      measured = revisions.find(
        (revision) => revision.kind === 'ability' && revision.id === 'measured-fire',
      );
    if (character?.kind !== 'character') throw new Error('Missing swordsman fixture');
    if (reveal?.kind !== 'ability') throw new Error('Missing reveal fire fixture');
    if (measured?.kind !== 'ability') throw new Error('Missing measured fire fixture');
    expect(character.definition.abilities.map(({ id }) => id)).not.toContain(reveal.id);
    expect(character.definition.abilities.map(({ id }) => id)).not.toContain(measured.id);

    const negativeManifest = await catalogManifest('swordsman', 'ember-duelist', 'flat', 400, 228),
      negative = await runAndReplay(negativeManifest, reveal, measured),
      negativeActor = negative.context.actors[0];
    expect(negative.battle.manifest.participants[0]!.skillLoadout).toBeUndefined();
    expect(negativeActor?.abilities.map(({ id }) => id)).not.toContain(reveal.id);
    expect(negativeActor?.abilities.map(({ id }) => id)).not.toContain(measured.id);
    expect(
      negative.run.records.some(
        (record) =>
          'events' in record &&
          record.events.some(
            (event) =>
              event.kind === 'launch' &&
              event.actorId === 'left' &&
              (event.abilityId === reveal.id || event.abilityId === measured.id),
          ),
      ),
    ).toBe(false);

    const nodeIds = ['skill.magic.rooster.1', 'skill.magic.rooster.2'],
      skills = new SkillStore(store),
      created = await skills.create({
        character: revisionReference(character),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.integrated.magic.rooster.2',
          version: 1,
          catalog: seeded.skillCatalog.reference,
          eligibilityNodeIds: nodeIds,
          learnedNodeIds: nodeIds,
          enabledNodeIds: [nodeIds[1]!],
        },
      }),
      reloaded = await skills.revision(created.latest),
      manifest = await catalogManifest('swordsman', 'ember-duelist', 'flat', 400, 228);
    manifest.participants[0]!.skillLoadout = await skillBattleReceipt(reloaded);
    const { run, context, restored } = await runAndReplay(manifest, reveal, measured);

    expect(reloaded.resolved).toMatchObject({
      explicitlyEnabledNodeIds: [nodeIds[1]],
      resolvedNodeIds: nodeIds,
      nodeResolutions: [
        {
          nodeId: nodeIds[0],
          resolution: [{ kind: 'active-ability', ability: revisionReference(reveal) }],
        },
        {
          nodeId: nodeIds[1],
          resolution: [{ kind: 'active-ability', ability: revisionReference(measured) }],
        },
      ],
    });
    expect(context.manifest.participants[0]!.skillLoadout).toMatchObject({
      catalog: seeded.skillCatalog.reference,
      resolvedNodeIds: nodeIds,
    });
    expect(context.actors[0]!.abilities.map(({ id }) => id)).toEqual(
      expect.arrayContaining([reveal.id, measured.id]),
    );
    expect(
      run.records.some(
        (record) =>
          'events' in record &&
          record.events.some(
            (event) =>
              event.kind === 'launch' &&
              event.actorId === 'left' &&
              event.abilityId === measured.id,
          ),
      ),
    ).toBe(true);
    expect(restored).toMatchObject({ ended: true, step: run.result.steps });
  });
});
