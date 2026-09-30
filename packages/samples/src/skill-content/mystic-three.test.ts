import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { SKILL_ZODIAC_IDS, canonicalJson, compareIds } from '@fantasy/domain';
import { reference, runBattle, sealRevision } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '../index.ts';
import { MYSTIC_SKILL_FIXTURES, type MysticSkillFixture } from './mystic-three-fixtures.ts';
import { MYSTIC_AVAILABLE_NODE_IDS, MYSTIC_SKILL_SHARDS } from './mystic-three.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const events = (records: Awaited<ReturnType<typeof runBattle>>['records']) =>
  records.flatMap((record) => ('events' in record ? record.events : []));

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
        expect(new Set(branch.map(({ name }) => name)).size).toBe(6);
        expect(new Set(branch.map(({ description }) => description)).size).toBe(6);
        expect(branch.every(({ deepening }) => deepening.retainsLowerUse)).toBe(true);
        expect(
          branch
            .filter(({ coordinate }) => coordinate.dan >= 5)
            .every(({ deepening }) => Boolean(deepening.conditionOrTradeoff)),
        ).toBe(true);
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
    'executes the exact published definition for %s',
    async (_id, fixture) => {
      const run = await runBattle(await forcedFixtureManifest(fixture));
      expect(
        events(run.records).some(
          (event) =>
            event.kind === 'launch' &&
            event.actorId === 'left' &&
            event.abilityId === fixture.abilityId,
        ),
      ).toBe(true);
      expect(run.result.steps).toBeLessThanOrEqual(200);
    },
  );
});
