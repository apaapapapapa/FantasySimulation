import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  ManifestSchema,
  ReplayState,
  revisionReference,
  skillBattleReceipt,
  type SkillNode,
} from '@fantasy/domain';
import { reference, runBattle, sealRevision } from '@fantasy/engine/spatial';
import { sampleCatalog } from '@fantasy/samples';
import { completeSkillTestCatalog } from '../../../../packages/domain/src/skill-system.test-fixtures.ts';
import { battleEvents } from '../../../../packages/engine/test-support/fixtures.ts';
import { reactionManifest } from '../../../../packages/engine/test-support/reactions.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { SkillStore } from '../db/skill-store.ts';
import { openStore, type Store } from '../db/store.ts';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('shield guard skill vertical fixture', () => {
  it('fixture.skill.shield.ox.1.guard-battle and fixture.skill.shield.ox.1.guard-replay resolve a saved guard loadout', async () => {
    const ability = (await sampleCatalog()).find(
      (revision) => revision.kind === 'ability' && revision.id === 'shield-set-guard-v1',
    );
    if (ability?.kind !== 'ability') throw new Error('Missing sealed shield guard ability');

    const source = await reactionManifest({
        reactions: [],
        steps: 80,
        character: { stamina: { max: 100, recoveryPerSecond: 10 } },
        attack: {
          categories: ['physical'],
          costs: { hp: 0, mp: 0, uses: 1 },
          effects: [
            { kind: 'damage', amount: 101, attackScaleBps: 0, element: 'physical' },
            {
              kind: 'force',
              profile: 'linear-v1',
              direction: 'away',
              speedMmPerSecond: 500,
              durationSteps: 2,
            },
          ],
        },
      }),
      left = source.participants[0]!,
      baseCharacter = source.revisions.find(
        (revision) => revision.kind === 'character' && revision.id === left.character.id,
      ),
      basePolicy =
        baseCharacter?.kind === 'character'
          ? source.revisions.find(
              (revision) =>
                revision.kind === 'policy' && revision.id === baseCharacter.definition.policy.id,
            )
          : undefined;
    if (baseCharacter?.kind !== 'character' || basePolicy?.kind !== 'policy') {
      throw new Error('Missing shield fixture character');
    }
    const policy = await sealRevision('policy', 'shield-guard-fixture-policy', 1, {
        ...basePolicy.definition,
        priorities: [],
        movement: 'hold',
      }),
      character = await sealRevision('character', 'shield-guard-fixture-character', 1, {
        ...baseCharacter.definition,
        stats: {
          ...baseCharacter.definition.stats,
          defense: 0,
          shield: 0,
          resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
        },
        abilities: [],
        policy: reference(policy),
      }),
      target = 'skill.shield.ox.1',
      fixtureIds = [
        'fixture.skill.shield.ox.1.guard-battle',
        'fixture.skill.shield.ox.1.guard-replay',
        'fixture.skill.shield.ox.1.guard-viewer',
      ],
      catalog = completeSkillTestCatalog();
    catalog.id = 'skill-catalog-v1';
    catalog.revision = 2;
    catalog.nodes = catalog.nodes.map((node): SkillNode =>
      node.id === target
        ? {
            ...node,
            lifecycle: 'available',
            prerequisites: [],
            resolution: [{ kind: 'passive-ability', ability: reference(ability) }],
            fixtureIds,
          }
        : {
            ...node,
            lifecycle: 'draft',
            prerequisites: [],
            resolution: [],
            fixtureIds: [],
          },
    );

    const store = openStore(':memory:');
    stores.push(store);
    await store.seedRevisions([...source.revisions, policy, character, ability]);
    const skills = new SkillStore(store),
      catalogRecord = await skills.seedCatalog(catalog),
      created = await skills.createLegacy({
        character: reference(character),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.fixture.shield.ox.guard',
          version: 1,
          catalog: catalogRecord.reference,
          eligibilityNodeIds: [target],
          learnedNodeIds: [target],
          enabledNodeIds: [target],
        },
      }),
      reloaded = await skills.revision(created.latest),
      receipt = await skillBattleReceipt(reloaded),
      participants = structuredClone(source.participants);
    participants[0] = {
      ...participants[0]!,
      character: reference(character),
      skillLoadout: receipt,
    };
    const battle = await store.prepareSpec({
        seed: source.seed,
        participants,
        ruleset: source.ruleset,
        scenario: source.scenario,
      }),
      output = await runBattle(battle.manifest),
      events = battleEvents(output.records),
      damage = events.find((event) => event.damage?.guard),
      saved = await recordedCheckpoints(ManifestSchema.parse(battle.manifest), output),
      replay = new ReplayState(saved.context);
    for (const record of output.records) replay.apply(record);
    if (!damage) throw new Error('Guard damage event was not recorded');

    expect(reloaded.resolved.nodeResolutions).toEqual([
      {
        nodeId: target,
        resolution: [{ kind: 'passive-ability', ability: reference(ability) }],
      },
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      character: revisionReference(character),
      catalog: catalogRecord.reference,
      resolvedNodeIds: [target],
    });
    expect(damage).toMatchObject({
      amount: 80,
      damage: {
        guard: {
          before: 101,
          after: 80,
          responses: [{ retainedDamageBps: 8000 }],
        },
      },
    });
    expect(damage.damage?.guard?.responses[0]?.activationId).toSatisfy((activationId: string) =>
      damage.causes.includes(activationId),
    );
    expect(events.filter(({ kind }) => kind === 'force')).toHaveLength(1);
    expect(saved.context.manifest.participants[0]?.skillLoadout).toEqual(receipt);
    expect(replay.checkpoint()).toEqual(saved.checkpoints.at(-1));
  });
});
