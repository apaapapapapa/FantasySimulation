import {
  createRevision,
  type TickAbility,
  type TickCharacter,
  type TickParticipant,
} from '@fantasy/domain/tick-v1';
import { createTickManifest, TICK_RULES } from '../../src/tick-v1/index.ts';

export function damage(power = 10, accuracyBps = 10_000): TickAbility['effect'] {
  return { kind: 'damage', power, damageType: 'physical', accuracyBps, aim: 'roll' };
}

export async function participant(
  id: string,
  effects: TickAbility['effect'][],
  options: {
    stats?: Partial<TickCharacter['stats']>;
    cost?: TickAbility['cost'];
    recoveryTicks?: number;
  } = {},
): Promise<TickParticipant> {
  const abilities = await Promise.all(
    effects.map((effect, index) =>
      createRevision(`${id}.ability.${index}.r1`, {
        id: `${id}.ability.${index}`,
        name: `${id} ${effect.kind}`,
        trigger: 'action' as const,
        recoveryTicks: options.recoveryTicks ?? 1,
        cost: options.cost ?? { hp: 0, mp: 0 },
        effect,
      }),
    ),
  );
  const strategy = await createRevision(`${id}.strategy.r1`, {
    id: `${id}.strategy`,
    kind: 'cycle' as const,
    abilityRevisionIds: abilities.map((ability) => ability.revisionId),
  });
  const character = await createRevision(`${id}.character.r1`, {
    id,
    name: id,
    sourceText: `Fixture: ${id}`,
    stats: {
      maxHp: 100,
      maxMp: 10,
      attack: 0,
      defense: 0,
      speed: 100,
      resistanceBps: { physical: 0, magical: 0 },
      avoidance: 'normal' as const,
      ...options.stats,
    },
    abilityRevisionIds: abilities.map((ability) => ability.revisionId),
    strategyRevisionId: strategy.revisionId,
    equipmentRevisionIds: [],
  });
  return { character, abilities, strategy, equipment: [] };
}

export async function matchup(
  left: TickParticipant,
  right: TickParticipant,
  options: {
    maxTick?: number;
    seed?: number;
    leftState?: Partial<{ hp: number; mp: number; shield: number; position: number }>;
    rightState?: Partial<{ hp: number; mp: number; shield: number; position: number }>;
  } = {},
) {
  return createTickManifest({
    participants: { left, right },
    seed: options.seed ?? 42,
    rules: await createRevision('tick-v1.rules.r1', TICK_RULES),
    scenario: await createRevision('arena.scenario.r1', {
      id: 'arena',
      maxTick: options.maxTick ?? 100,
      initialState: {
        left: {
          hp: left.character.definition.stats.maxHp,
          mp: left.character.definition.stats.maxMp,
          shield: 0,
          position: -10,
          ...options.leftState,
        },
        right: {
          hp: right.character.definition.stats.maxHp,
          mp: right.character.definition.stats.maxMp,
          shield: 0,
          position: 10,
          ...options.rightState,
        },
      },
    }),
  });
}

export async function goldenCases() {
  return [
    {
      name: 'simultaneous-defeat',
      manifest: await matchup(
        await participant('duelist-a', [damage(100)]),
        await participant('duelist-b', [damage(100)]),
      ),
    },
    {
      name: 'heal-offset',
      manifest: await matchup(
        await participant('healer', [{ kind: 'heal', amount: 20 }]),
        await participant('striker', [damage(15)]),
        { maxTick: 0, leftState: { hp: 10 } },
      ),
    },
    {
      name: 'seeded-battle',
      manifest: await matchup(
        await participant('ranger', [damage(30, 5_000)]),
        await participant('guard', [damage(25, 6_000)], { stats: { defense: 2, speed: 50 } }),
      ),
    },
    {
      name: 'unresolved-accuracy',
      manifest: await matchup(
        await participant('certain-strike', [
          {
            kind: 'damage',
            power: 50,
            damageType: 'magical',
            accuracyBps: 10_000,
            aim: 'certain-hit',
          },
        ]),
        await participant('certain-evade', [{ kind: 'wait' }], {
          stats: { avoidance: 'certain-evade' },
        }),
      ),
    },
  ];
}
