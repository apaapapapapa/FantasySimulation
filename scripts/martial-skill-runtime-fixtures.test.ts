import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  ReplayState,
  SkillLoadoutReceiptSchema,
  canonicalJson,
  contentHash,
  replayContext,
} from '@fantasy/domain';
import { ManifestBuilder, initializePhysics, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { readMartialSkillContent } from './martial-skill-content.ts';

beforeAll(initializePhysics);

const fixtureNodes = ['skill.aikido.dog.1'] as const;

async function exactSkillBattle(nodeId: (typeof fixtureNodes)[number]) {
  const content = readMartialSkillContent(),
    node = content.shards.flatMap(({ nodes }) => nodes).find(({ id }) => id === nodeId),
    evidence = content.fixtures.evidence.find((fixture) => fixture.nodeId === nodeId);
  if (!node || node.lifecycle !== 'available' || node.resolution.length !== 1)
    throw new Error(`Missing exact available martial node: ${nodeId}`);
  if (!evidence || !node.fixtureIds.includes(evidence.fixtureId))
    throw new Error(`Missing exact martial runtime fixture: ${nodeId}`);
  const resolution = node.resolution[0]!;
  if (resolution.kind === 'augment')
    throw new Error(`Martial runtime fixture cannot resolve an augment: ${nodeId}`);
  const abilityRef = resolution.ability,
    spatial = await sampleCatalog(),
    ability = spatial.find(
      (revision) =>
        revision.kind === 'ability' &&
        revision.id === abilityRef.id &&
        revision.revision === abilityRef.revision &&
        revision.contentHash === abilityRef.contentHash,
    );
  if (!ability || ability.kind !== 'ability')
    throw new Error(`Missing exact martial ability revision: ${nodeId}`);
  const manifest = await catalogManifest(
      'posture-duelist-v1',
      'phoenix-duelist-v1',
      'flat',
      800,
      228,
    ),
    catalog = {
      id: content.source.catalogId,
      revision: content.source.catalogRevision,
      contentHash: await contentHash(JSON.parse(canonicalJson(content.shards))),
    },
    loadout = {
      id: `loadout.${nodeId}`,
      revision: 1,
      contentHash: await contentHash({ schemaVersion: 1, nodeIds: [nodeId] }),
    },
    nodeResolutions = [{ nodeId, resolution: node.resolution }],
    resolvedNodeIds = [nodeId],
    resolutionDigest = await contentHash(
      JSON.parse(
        canonicalJson({
          resolverVersion: 'skill-resolver-v1',
          catalog,
          resolvedNodeIds,
          nodeResolutions,
        }),
      ),
    ),
    participants = structuredClone(manifest.participants);
  participants[0]!.position.x = -1000;
  participants[1]!.position.x = 1000;
  participants[0]!.skillLoadout = SkillLoadoutReceiptSchema.parse({
    schemaVersion: 2,
    resolverVersion: 'skill-resolver-v1',
    character: participants[0]!.character,
    catalog,
    loadout,
    explicitlyEnabledNodeIds: resolvedNodeIds,
    resolvedNodeIds,
    nodeResolutions,
    resolutionDigest,
  });
  const battle = await ManifestBuilder.from([...manifest.revisions, ability]).build({
    seed: manifest.seed,
    participants,
    ruleset: manifest.ruleset,
    scenario: manifest.scenario,
  });
  return { battle, node, ability, evidence };
}

describe('SK-04 exact runtime release fixtures', () => {
  it.each(fixtureNodes)(
    'binds %s through loadout, battle and deterministic replay',
    async (nodeId) => {
      const { battle, node, ability, evidence } = await exactSkillBattle(nodeId),
        run = await runBattle(battle.manifest),
        events = run.records.flatMap((record) => ('events' in record ? record.events : [])),
        context = await replayContext(battle.manifest, run.result.simulationHash),
        receipt = context.actors[0]!.participant.skillLoadout;
      expect(receipt?.resolvedNodeIds).toEqual([nodeId]);
      expect(receipt?.nodeResolutions).toEqual([{ nodeId, resolution: node.resolution }]);
      expect(evidence.definition).toEqual({
        id: ability.id,
        revision: ability.revision,
        contentHash: ability.contentHash,
      });
      expect(context.actors[0]!.abilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: ability.id,
            revision: ability.revision,
            contentHash: ability.contentHash,
          }),
        ]),
      );
      const witnessed = events.some(
        (event) =>
          event.actorId === 'left' &&
          event.abilityId === ability.id &&
          event.kind === 'reaction' &&
          event.ruleId === 'reaction.activated',
      );
      expect(witnessed).toBe(true);
      const restored = new ReplayState(context);
      for (const record of run.records) restored.apply(record);
      expect(restored).toMatchObject({ ended: true, step: run.result.steps });
      const replayed = new ReplayState(context);
      for (const record of run.records) replayed.apply(record);
      expect(replayed.checkpoint()).toEqual(restored.checkpoint());
    },
  );
});
