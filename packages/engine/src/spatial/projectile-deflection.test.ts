import { expect, it } from 'vite-plus/test';
import { AbilitySchema, DEFAULT_BUDGET, type Definition } from '@fantasy/domain/spatial';
import { reactionManifest } from '../../test-support/reactions.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';

import {
  deflectionShape as projectile,
  deflectionResponse as deflect,
} from '../../test-support/deflection.ts';

it('returns a projectile once with unchanged launch power and records the contact turn', async () => {
  const input = await reactionManifest({
    reactions: [deflect],
    leftReactions: false,
    rightAttack: false,
    attack: { attack: projectile },
  });
  const result = await runBattle(input);
  const events = battleEvents(result.records);
  const turn = events.filter((e) => e.kind === 'projectile-deflect');
  expect(turn).toHaveLength(1);
  expect(turn[0]!.projectileDeflection).toMatchObject({
    originalOwnerId: input.participants[0].actorId,
    ownerId: input.participants[1].actorId,
    powerBps: 10000,
  });
  const damage = events.filter((e) => e.kind === 'damage');
  expect(damage).toHaveLength(1);
  expect(damage[0]).toMatchObject({
    actorId: input.participants[1].actorId,
    targetId: input.participants[0].actorId,
    amount: 5,
  });
  expect(await runBattle(input)).toEqual(result);
  await recordedCheckpoints(input, result);
});

it.each([
  ['insufficient cost', { ...deflect, costs: { hp: 0, mp: 1000000, uses: 1 } }, projectile],
  [
    'category filter',
    { reaction: { response: { kind: 'deflect' }, categories: ['special'] } },
    projectile,
  ],
  ['hitscan', deflect, { kind: 'hitscan', radiusMm: 0 }],
] satisfies [string, Partial<Definition<'ability'>>, Definition<'ability'>['attack']][])(
  'retains ordinary damage for %s',
  async (_name, reaction, shape) => {
    const input = await reactionManifest({
      reactions: [structuredClone(reaction)],
      leftReactions: false,
      rightAttack: false,
      attack: { attack: structuredClone(shape) },
    });
    const events = battleEvents((await runBattle(input)).records);
    expect(events.filter((e) => e.kind === 'projectile-deflect')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'damage')).toEqual([
      expect.objectContaining({ targetId: input.participants[1].actorId, amount: 5 }),
    ]);
  },
);

it('does not bounce between two deflectors', async () => {
  const input = await reactionManifest({
    reactions: [deflect],
    rightAttack: false,
    attack: { attack: projectile },
  });
  const events = battleEvents((await runBattle(input)).records);
  expect(events.filter((e) => e.kind === 'projectile-deflect')).toHaveLength(1);
  expect(events.filter((e) => e.kind === 'damage')).toEqual([
    expect.objectContaining({ targetId: input.participants[0].actorId }),
  ]);
});

it('reserves deflection instead of competing same-contact parry and truncates atomically', async () => {
  const input = await reactionManifest({
    reactions: [
      deflect,
      {
        reaction: { response: { kind: 'parry', scope: 'all' } },
        costs: { hp: 0, mp: 1000000, uses: 1 },
      },
    ],
    leftReactions: false,
    rightAttack: false,
    attack: { attack: projectile },
  });
  const events = battleEvents((await runBattle(input)).records);
  expect(
    events
      .filter((e) => e.kind === 'reaction' && e.ruleId === 'reaction.activated')
      .map((e) => e.reason),
  ).toEqual(['deflect']);
  const twin = await reactionManifest({ reactions: [deflect], attack: { attack: projectile } });
  const limited = await runBattle(twin, { ...DEFAULT_BUDGET, maxReactionsPerTransaction: 1 });
  expect(limited.result.outcome).toMatchObject({ kind: 'truncated' });
  expect(battleEvents(limited.records).filter((e) => e.kind === 'projectile-deflect')).toHaveLength(
    0,
  );
});

it('accepts only empty before-hit deflection payloads', async () => {
  const input = await reactionManifest({ reactions: [deflect] });
  const ability = input.revisions.find(
    (r) => r.kind === 'ability' && r.definition.reaction?.response.kind === 'deflect',
  )!;
  for (const edit of [
    { trigger: 'after-damage' },
    { effects: [{ kind: 'heal', amount: 1 }] },
    { reaction: { response: { kind: 'deflect', powerBps: 30001 } } },
  ])
    expect(AbilitySchema.safeParse({ ...ability.definition, ...edit }).success).toBe(false);
});

it.each([
  [15000, 22500, 40],
  [25000, 30000, 55],
])(
  'combines simultaneous deflectors once with a final power cap for %i',
  async (secondPower, expectedPower, expectedDamage) => {
    const input = await reactionManifest({
      reactions: [15000, secondPower].map((powerBps, i) => ({
        reaction: { response: { kind: 'deflect', powerBps } },
        costs: { hp: 0, mp: i + 2, uses: 1 },
      })),
      leftReactions: false,
      rightAttack: false,
      attack: {
        attack: projectile,
        effects: [{ kind: 'damage', amount: 20, attackScaleBps: 0, element: 'physical' }],
      },
    });
    const output = await runBattle(input);
    const events = battleEvents(output.records);
    const turns = events.filter((e) => e.kind === 'projectile-deflect');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.projectileDeflection!.powerBps).toBe(expectedPower);
    expect(turns[0]!.projectileDeflection!.activations).toHaveLength(2);
    const paid = events.find((e) => e.kind === 'cost' && e.ruleId === 'reaction.cost-group')!;
    expect(paid.before!.mp - paid.after!.mp).toBe(5);
    expect(events.filter((e) => e.kind === 'damage')).toEqual([
      expect.objectContaining({ targetId: 'left', amount: expectedDamage }),
    ]);
    await recordedCheckpoints(input, output);
  },
);
