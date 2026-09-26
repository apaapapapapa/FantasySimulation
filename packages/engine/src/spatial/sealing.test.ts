import { expect, it } from 'vite-plus/test';
import { effectiveStatuses, StatusSchema, statusSealed } from '@fantasy/domain/spatial';
import type { StatusCohort } from './state.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { revivalManifest } from '../../test-support/revival.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { sealRevision } from './manifest-builder.ts';
import { runBattle } from './run.ts';
import { statusBoundary, effectiveStats } from './rules/status.ts';
import { adjustedStatusValue } from './rules/status-modifiers.ts';
import { planStatusReactions, reactionDamageBps } from './rules/status-reactions.ts';
import { flightRate } from './rules/locomotion.ts';
import { prepareBattle } from './prepare.ts';

async function sealingCohorts() {
  const buff = await sealRevision(
    'status',
    'permanent-flight',
    1,
    initialStatus({
      categories: ['permanent', 'buff'],
      visibility: 'visible',
      modifiers: { attack: 5, defense: 2, speedBps: 20000, flight: true, rooted: false },
      adjustments: [{ target: 'hpRecovery', operation: 'multiply', amount: 20000 }],
      flightStaminaPerSecond: 3,
      periodic: [{ kind: 'resource', resource: 'mp', amount: 1, everySteps: 2 }],
      reactions: [
        { element: 'fire', response: { kind: 'strengthen', stacks: 1 }, damageTakenBps: 5000 },
      ],
    }),
  );
  const seal = await sealRevision(
    'status',
    'seal-buffs',
    1,
    initialStatus({
      categories: ['buff'],
      seals: { statusCategories: ['buff'], statusIds: ['seal-buffs'] },
    }),
  );
  const cohorts: StatusCohort[] = [
    { revision: buff, startStep: 0, endStep: 100, stacks: 1, causes: [] },
    { revision: seal, startStep: 2, endStep: 5, stacks: 1, causes: [] },
  ];
  return { buff, seal, cohorts };
}
it('suspends permanent modifiers flight pulses and elemental reactions without removing cohorts or pausing clocks', async () => {
  const { buff, seal, cohorts } = await sealingCohorts();
  const actor = (await prepareBattle(await revivalManifest())).actors[0];
  expect(effectiveStats(actor, cohorts, 1)).toMatchObject({
    attack: 5,
    defense: 2,
    speedBps: 20000,
    flight: true,
  });
  expect(effectiveStats(actor, cohorts, 2)).toMatchObject({
    attack: 0,
    defense: 0,
    speedBps: 10000,
    flight: false,
  });
  expect(adjustedStatusValue(10000, 'hpRecovery', cohorts, 3)).toBe(10000);
  expect(flightRate(cohorts, 3)).toBe(0);
  expect(statusBoundary(cohorts, 2).pulses).toHaveLength(0);
  expect(statusBoundary(cohorts, 4).statuses).toHaveLength(2);
  expect(statusBoundary(cohorts, 5).pulses).toHaveLength(0);
  expect(statusBoundary(cohorts, 6).pulses).toHaveLength(1);
  expect(effectiveStats(actor, cohorts, 5).flight).toBe(true);
  expect(reactionDamageBps(cohorts, 2, 'fire')).toBe(10000);
  expect(
    planStatusReactions(cohorts, [{ id: 'e.1', element: 'fire' }], [buff, seal], 2).traces,
  ).toHaveLength(0);
  expect(reactionDamageBps(cohorts, 5, 'fire')).toBe(5000);
});
it('keeps seals immune and makes selector union and enumeration order irrelevant', async () => {
  const { cohorts } = await sealingCohorts();
  expect(statusSealed(cohorts[0]!, cohorts, 2)).toBe(true);
  expect(statusSealed(cohorts[1]!, cohorts, 2)).toBe(false);
  expect(effectiveStatuses(cohorts, 2)).toEqual([cohorts[1]]);
  expect(effectiveStatuses([...cohorts].reverse(), 2)).toEqual([cohorts[1]]);
  expect(StatusSchema.safeParse(initialStatus({ seals: {} })).success).toBe(false);
  expect(StatusSchema.safeParse(initialStatus({ seals: { abilityCategories: [] } })).success).toBe(
    false,
  );
});
it.each([true, false])(
  'blocks categorized revival only while its seal is active, sealed=%s',
  async (sealed) => {
    const input = await revivalManifest();
    for (const i of [0, 1] as const)
      await withInitialStatus(
        input,
        i,
        initialStatus({
          seals: { abilityCategories: sealed ? ['special'] : ['physical'] },
          durationSteps: 10,
        }),
      );
    const run = await runBattle(input);
    await recordedCheckpoints(input, run);
    expect(battleEvents(run.records).filter((e) => e.revival)).toHaveLength(sealed ? 0 : 2);
    expect(run.result.outcome).toEqual({
      kind: 'draw',
      reason: sealed ? 'mutual-defeat' : 'time-limit',
    });
  },
);
it('blocks categorized actions during sealing and permits them after expiry', async () => {
  const input = await revivalManifest({
    steps: 20,
    reactions: [],
    attack: {
      categories: ['magic'],
      castSteps: 2,
      costs: { hp: 0, mp: 0, uses: 0 },
      effects: [{ kind: 'damage', amount: 1, attackScaleBps: 0, element: 'fire', defense: 'none' }],
    },
  });
  for (const i of [0, 1] as const)
    await withInitialStatus(
      input,
      i,
      initialStatus({
        seals: { abilityCategories: ['magic'] },
        durationSteps: 8,
      }),
    );
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const events = battleEvents(run.records);
  expect(
    events.some(
      (e) =>
        e.cognition?.kind === 'decision' && e.cognition.excluded.some((x) => x.reason === 'sealed'),
    ),
  ).toBe(true);
  expect(events.filter((e) => e.kind === 'damage').every((e) => e.step >= 8)).toBe(true);
  expect(events.filter((e) => e.kind === 'damage').length).toBeGreaterThan(0);
});

it('loses active flight support when sealed and retains the flight cohort for restoration', async () => {
  const seal = await sealRevision(
    'status',
    'flight-seal-contact',
    1,
    initialStatus({
      seals: { statusCategories: ['buff'] },
      stackKey: 'flight-seal',
      durationSteps: 20,
    }),
  );
  const input = await revivalManifest({
    steps: 25,
    reactions: [],
    revisions: [seal],
    attack: {
      castSteps: 0,
      effects: [
        {
          kind: 'apply-status',
          status: { id: seal.id, revision: seal.revision, contentHash: seal.contentHash },
        },
      ],
    },
  });
  for (const p of input.participants) p.position.y = 3500;
  await withInitialStatus(
    input,
    0,
    initialStatus({
      categories: ['buff'],
      durationSteps: 50,
      modifiers: { attack: 0, defense: 0, speedBps: 10000, rooted: false, flight: true },
    }),
  );
  const run = await runBattle(input);
  const { checkpoints } = await recordedCheckpoints(input, run);
  const positions = checkpoints.map((c) => ({ step: c.step, actor: c.state!.actors[0]! }));
  const before = positions.find((p) => p.step === 5)!;
  const after = positions.filter((p) => p.step === 20).at(-1)!;
  expect(before.actor.velocity.y).toBeGreaterThanOrEqual(0);
  expect(after.actor.velocity.y).toBeLessThan(0);
  expect(after.actor.statuses.some((s) => s.revision.id === seal.id)).toBe(true);
  expect(after.actor.statuses.some((s) => s.revision.id === 'initial-status-0')).toBe(true);
});

it('cancels an already casting spell when an opponent seals its category before release', async () => {
  const seal = await sealRevision(
    'status',
    'cast-seal',
    1,
    initialStatus({
      stackKey: 'cast-seal',
      seals: { abilityCategories: ['magic'] },
      durationSteps: 50,
    }),
  );
  const input = await revivalManifest({
    steps: 20,
    reactions: [],
    attack: {
      categories: ['magic'],
      castSteps: 8,
    },
  });
  const primary = input.revisions.find((r) => r.kind === 'ability')!;
  const right = input.revisions.find(
    (r) => r.kind === 'character' && r.id === input.participants[1].character.id,
  )!;
  const oldPolicy = input.revisions.find(
    (r) =>
      r.kind === 'policy' &&
      r.id === (right.kind === 'character' ? right.definition.policy.id : ''),
  )!;
  if (right.kind !== 'character' || oldPolicy.kind !== 'policy')
    throw new Error('Missing casting actors');
  const ability = await sealRevision('ability', 'interrupting-sealer', 1, {
    ...primary.definition,
    castSteps: 0,
    categories: ['technique'],
    effects: [
      {
        kind: 'apply-status',
        status: { id: seal.id, revision: seal.revision, contentHash: seal.contentHash },
      },
    ],
  });
  const policy = await sealRevision('policy', 'interrupting-policy', 1, {
    ...oldPolicy.definition,
    priorities: [{ abilityId: ability.id, when: { kind: 'always' } }],
  });
  const character = await sealRevision('character', 'interrupting-owner', 1, {
    ...right.definition,
    abilities: [{ id: ability.id, revision: ability.revision, contentHash: ability.contentHash }],
    policy: { id: policy.id, revision: policy.revision, contentHash: policy.contentHash },
  });
  input.revisions.push(seal, ability, policy, character);
  input.participants[1].character = {
    id: character.id,
    revision: character.revision,
    contentHash: character.contentHash,
  };
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const events = battleEvents(run.records).filter((e) => e.actorId === 'left');
  expect(events.some((e) => e.kind === 'cast-start' && e.step === 5)).toBe(true);
  expect(events.some((e) => e.kind === 'fizzle' && e.phase === 'launch' && e.step === 13)).toBe(
    true,
  );
  expect(events.filter((e) => e.kind === 'damage')).toHaveLength(0);
});
