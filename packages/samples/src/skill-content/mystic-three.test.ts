import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  EXPECTED_SKILL_COORDINATES,
  ReplayState,
  SKILL_ZODIAC_IDS,
  SkillCatalogSchema,
  canonicalJson,
  compareIds,
  replayContext,
  resolveSkillLoadout,
  skillBattleReceipt,
  skillCatalogDigest,
  skillLoadoutRevisionHash,
  type SkillCatalog,
} from '@fantasy/domain';
import { ManifestBuilder, reference, runBattle, sealRevision } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '../index.ts';
import { MYSTIC_SKILL_FIXTURES, type MysticSkillFixture } from './mystic-three-fixtures.ts';
import { MYSTIC_AVAILABLE_NODE_IDS, MYSTIC_SKILL_SHARDS } from './mystic-three.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const events = (records: Awaited<ReturnType<typeof runBattle>>['records']) =>
  records.flatMap((record) => ('events' in record ? record.events : []));
const deepeningByDan = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const;

function resolverCatalog(): SkillCatalog {
  const mysticNodes = Object.values(MYSTIC_SKILL_SHARDS).flatMap(({ nodes }) => nodes),
    mysticPaths = new Set(Object.keys(MYSTIC_SKILL_SHARDS)),
    filler = EXPECTED_SKILL_COORDINATES.filter(({ path }) => !mysticPaths.has(path)).map(
      ({ path, zodiac, dan }) => ({
        id: `skill.${path}.${zodiac}.${dan}`,
        coordinate: { path, zodiac, dan },
        name: `Resolver fixture ${path} ${zodiac} ${dan}`,
        description: 'Test-only draft coordinate completing the resolver catalog.',
        lifecycle: 'draft' as const,
        prerequisites: dan === 1 ? [] : [`skill.${path}.${zodiac}.${dan - 1}`],
        deepening: {
          kind: deepeningByDan[dan - 1],
          explanation: 'Test-only resolver catalog closure.',
          retainsLowerUse: true,
          ...(dan >= 5 ? { conditionOrTradeoff: 'Test-only upper-dan tradeoff.' } : {}),
        },
        pathRoleTags: ['test.resolver-closure'],
        resolution: [],
        fixtureIds: [],
      }),
    );
  return SkillCatalogSchema.parse({
    schemaVersion: 1,
    id: 'skill-catalog-v1',
    revision: 2,
    nodes: [...mysticNodes, ...filler],
  });
}

async function forcedFixtureManifest(fixture: MysticSkillFixture) {
  const input = await catalogManifest(
      fixture.actor,
      fixture.opponent,
      fixture.scenario,
      200,
      42,
      fixture.ruleset,
    ),
    actor = input.revisions.find(
      (revision) => revision.kind === 'character' && revision.id === fixture.actor,
    );
  if (actor?.kind !== 'character') throw new Error(`Missing fixture actor ${fixture.actor}`);
  const policy = input.revisions.find(
    (revision) =>
      revision.kind === 'policy' &&
      revision.id === actor.definition.policy.id &&
      revision.revision === actor.definition.policy.revision,
  );
  if (policy?.kind !== 'policy')
    throw new Error(`Missing fixture policy ${actor.definition.policy.id}`);
  const forcedPolicy = await sealRevision('policy', `fixture.policy.${fixture.abilityId}`, 1, {
      ...policy.definition,
      priorities: [{ abilityId: fixture.abilityId, when: { kind: 'always' as const } }],
    }),
    forcedActor = await sealRevision('character', `fixture.character.${fixture.abilityId}`, 1, {
      ...actor.definition,
      policy: reference(forcedPolicy),
    });
  input.participants[0]!.character = reference(forcedActor);
  input.revisions = [
    ...input.revisions.filter(
      (revision) => !(revision.kind === 'character' && revision.id === actor.id),
    ),
    forcedActor,
    forcedPolicy,
  ];
  return input;
}

async function savedFixtureManifest(fixture: MysticSkillFixture) {
  const manifest = await forcedFixtureManifest(fixture),
    catalog = resolverCatalog(),
    catalogRef = {
      id: catalog.id,
      revision: catalog.revision,
      contentHash: await skillCatalogDigest(catalog),
    },
    configuration = {
      schemaVersion: 1 as const,
      id: `loadout.${fixture.id}`,
      version: 1,
      catalog: catalogRef,
      eligibilityNodeIds: [fixture.nodeId],
      learnedNodeIds: [fixture.nodeId],
      enabledNodeIds: [fixture.nodeId],
    },
    content = {
      schemaVersion: 1 as const,
      id: configuration.id,
      revision: 1,
      character: manifest.participants[0]!.character,
      configuration,
      resolved: await resolveSkillLoadout(catalog, configuration, []),
    },
    snapshot = { ...content, contentHash: await skillLoadoutRevisionHash(content) },
    receipt = await skillBattleReceipt(snapshot);
  manifest.participants[0]!.skillLoadout = receipt;
  const battle = await ManifestBuilder.from(manifest.revisions).build({
    seed: manifest.seed,
    participants: manifest.participants,
    ruleset: manifest.ruleset,
    scenario: manifest.scenario,
  });
  return { manifest: battle.manifest, receipt, snapshot };
}

describe('mystic path catalog content', () => {
  it('owns three exact 72-node shards with meaningful six-dan branch progression', () => {
    expect(Object.keys(MYSTIC_SKILL_SHARDS).sort(compareIds)).toEqual(['magic', 'renki', 'shinto']);
    for (const [path, shard] of Object.entries(MYSTIC_SKILL_SHARDS)) {
      expect(shard.nodes).toHaveLength(72);
      expect(shard.nodes.filter(({ lifecycle }) => lifecycle === 'draft')).toHaveLength(
        72 - MYSTIC_AVAILABLE_NODE_IDS.filter((id) => id.startsWith(`skill.${path}.`)).length,
      );
      for (const zodiac of SKILL_ZODIAC_IDS) {
        const branch = shard.nodes.filter((node) => node.coordinate.zodiac === zodiac);
        expect(branch.map(({ coordinate }) => coordinate.dan)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(branch.map(({ prerequisites }) => prerequisites)).toEqual([
          [],
          [`skill.${path}.${zodiac}.1`],
          [`skill.${path}.${zodiac}.2`],
          [`skill.${path}.${zodiac}.3`],
          [`skill.${path}.${zodiac}.4`],
          [`skill.${path}.${zodiac}.5`],
        ]);
        const distinctNames = new Set(branch.map(({ name }) => name)).size,
          distinctDescriptions = new Set(branch.map(({ description }) => description)).size,
          retainedLowerUses = branch.every(({ deepening }) => deepening.retainsLowerUse),
          upperDanCostsAreExplicit = branch
            .filter(({ coordinate }) => coordinate.dan >= 5)
            .every(({ deepening }) => Boolean(deepening.conditionOrTradeoff));
        expect({
          distinctNames,
          distinctDescriptions,
          retainedLowerUses,
          upperDanCostsAreExplicit,
        }).toEqual({
          distinctNames: 6,
          distinctDescriptions: 6,
          retainedLowerUses: true,
          upperDanCostsAreExplicit: true,
        });
      }
    }
  });

  it('marks only exact published definitions with one complete fixture as available', async () => {
    const revisions = await sampleCatalog(),
      abilities = new Map(
        revisions
          .filter((revision) => revision.kind === 'ability')
          .map((revision) => [revision.id, revision]),
      ),
      nodes = Object.values(MYSTIC_SKILL_SHARDS).flatMap(({ nodes: shardNodes }) => shardNodes),
      available = nodes.filter(({ lifecycle }) => lifecycle === 'available'),
      fixtureByNode = new Map(MYSTIC_SKILL_FIXTURES.map((fixture) => [fixture.nodeId, fixture]));

    expect(available).toHaveLength(19);
    expect(MYSTIC_SKILL_FIXTURES).toHaveLength(available.length);
    expect(new Set(MYSTIC_SKILL_FIXTURES.map(({ id }) => id)).size).toBe(
      MYSTIC_SKILL_FIXTURES.length,
    );
    for (const node of available) {
      const fixture = fixtureByNode.get(node.id),
        resolution = node.resolution[0];
      expect(fixture).toBeDefined();
      expect(node.coordinate.dan).toBe(1);
      expect(node.fixtureIds).toEqual([fixture!.id]);
      expect(node.resolution).toHaveLength(1);
      expect(resolution?.kind).toMatch(/^(active|passive)-ability$/);
      if (!resolution || resolution.kind === 'augment') throw new Error('Expected direct ability');
      expect(canonicalJson(resolution.ability)).toBe(
        canonicalJson({
          id: fixture!.abilityId,
          revision: abilities.get(fixture!.abilityId)?.revision,
          contentHash: abilities.get(fixture!.abilityId)?.contentHash,
        }),
      );
    }
    expect(
      nodes
        .filter(({ lifecycle }) => lifecycle === 'draft')
        .every(({ resolution, fixtureIds }) => !resolution.length && !fixtureIds.length),
    ).toBe(true);
  });

  it('binds every available fixture to resource duplicate duration release and interference evidence', async () => {
    const catalog = await sampleCatalog(),
      characters = new Map(
        catalog
          .filter((revision) => revision.kind === 'character')
          .map((revision) => [revision.id, revision]),
      );
    for (const fixture of MYSTIC_SKILL_FIXTURES) {
      expect(fixture.mechanisms.length).toBeGreaterThan(0);
      expect(Object.values(fixture.boundaries).every((value) => value.length >= 10)).toBe(true);
      expect(fixture.evidenceTests.length).toBeGreaterThan(0);
      expect(fixture.evidenceTests.every((path) => existsSync(repositoryRoot + path))).toBe(true);
      const actor = characters.get(fixture.actor);
      expect(actor?.kind).toBe('character');
      if (actor?.kind !== 'character') throw new Error(`Missing actor ${fixture.actor}`);
      expect(actor.definition.abilities.some(({ id }) => id === fixture.abilityId)).toBe(true);
    }
  });

  it.each(MYSTIC_SKILL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    'carries saved loadout %s through AI, battle events and replay provenance',
    async (_id, fixture) => {
      const { manifest, receipt, snapshot } = await savedFixtureManifest(fixture),
        run = await runBattle(manifest),
        replay = await replayContext(manifest, run.result.simulationHash),
        restored = new ReplayState(replay);
      for (const record of run.records) restored.apply(record);

      expect(snapshot.resolved.nodeResolutions).toEqual([
        expect.objectContaining({ nodeId: fixture.nodeId }),
      ]);
      expect(receipt.loadout).toEqual({
        id: snapshot.id,
        revision: snapshot.revision,
        contentHash: snapshot.contentHash,
      });
      expect(receipt.catalog).toEqual(snapshot.resolved.catalog);
      expect(manifest.participants[0]!.skillLoadout).toEqual(receipt);
      expect(replay.manifest.participants[0]!.skillLoadout).toEqual(receipt);
      expect(replay.actors[0]!.abilities.map(({ id }) => id)).toContain(fixture.abilityId);
      const resolution = receipt.nodeResolutions[0]!.resolution[0]!;
      if (resolution.kind === 'active-ability') {
        const policy = replay.manifest.revisions.find(
          (revision) =>
            revision.kind === 'policy' && revision.id === `fixture.policy.${fixture.abilityId}`,
        );
        expect(policy?.kind).toBe('policy');
        if (policy?.kind !== 'policy') throw new Error('Missing forced fixture policy');
        expect(policy.definition.priorities).toContainEqual({
          abilityId: fixture.abilityId,
          when: { kind: 'always' },
        });
      } else expect(resolution.kind).toBe('passive-ability');
      expect(
        events(run.records).some(
          (event) =>
            event.kind === 'launch' &&
            event.actorId === 'left' &&
            event.abilityId === fixture.abilityId,
        ),
      ).toBe(true);
      expect(restored).toMatchObject({ ended: true, step: run.result.steps });
      expect(run.result.steps).toBeLessThanOrEqual(200);
    },
  );
});
