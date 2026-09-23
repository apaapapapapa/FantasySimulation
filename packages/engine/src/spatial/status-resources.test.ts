import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { StreamRecordSchema, type Definition } from '@fantasy/domain/spatial';
import { aiFixture, initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { battleEvents, combatManifest } from '../../test-support/fixtures.ts';
import { initializePhysics } from './physics.ts';
import { prepareBattle, reference } from './prepare.ts';
import { runBattle } from './run.ts';
import { assessStatusEffect } from './status-assessment.ts';

beforeAll(initializePhysics);
async function resourceCombat(
  status: Partial<Definition<'status'>>,
  steps = 12,
  recoveryPerSecond = 0,
) {
  const manifest = await combatManifest(steps, {
    character: { stamina: { max: 10, recoveryPerSecond, resumeAt: 3 } },
    ability: {
      trigger: 'battle-start',
      target: 'self',
      attack: { kind: 'direct' },
      castSteps: 0,
      costs: { hp: 0, mp: 20, stamina: 8, uses: 1 },
      effects: [{ kind: 'shield', amount: 1 }],
    },
    policy: { movement: 'hold', priorities: [] },
  });
  await withInitialStatus(manifest, 0, initialStatus({ durationSteps: 10, ...status }));
  return manifest;
}

describe('G-03 resource states through the G-04 resource API', () => {
  it('sums signed MP and stamina pulses once before clamping and expires before the next pulse', async () => {
    const manifest = await resourceCombat({
      periodic: [
        { kind: 'resource', resource: 'mp', amount: 30, everySteps: 5 },
        { kind: 'resource', resource: 'mp', amount: -15, everySteps: 5 },
        { kind: 'resource', resource: 'stamina', amount: 9, everySteps: 5 },
        { kind: 'resource', resource: 'stamina', amount: -4, everySteps: 5 },
      ],
    });
    const run = await runBattle(manifest);
    for (const record of run.records)
      expect(StreamRecordSchema.safeParse(record).success).toBe(true);
    const pulses = battleEvents(run.records).filter((e) => e.ruleId === 'status.resource-pulse');
    expect(pulses.map((e) => [e.step, e.reason, e.amount, e.after?.mp, e.after?.stamina])).toEqual([
      [0, 'mp:increase', 15, 95, 7],
      [0, 'stamina:increase', 5, 95, 7],
      [5, 'mp:increase', 5, 100, 10],
      [5, 'stamina:increase', 3, 100, 10],
    ]);
    expect(pulses.every((e) => e.causes.length === 1)).toBe(true);
    expect(battleEvents(run.records).some((e) => e.kind === 'status-remove' && e.step === 10)).toBe(
      true,
    );
    expect((await runBattle(manifest)).result).toEqual(run.result);
  });

  it('retains permanent drains and clamps to zero without creating stamina on legacy actors', async () => {
    const definition = initialStatus({
      categories: ['permanent'],
      durationSteps: 1,
      periodic: [
        { kind: 'resource', resource: 'mp', amount: -30, everySteps: 5 },
        { kind: 'resource', resource: 'stamina', amount: -8, everySteps: 5 },
      ],
    });
    const manifest = await resourceCombat(definition);
    const events = battleEvents((await runBattle(manifest)).records);
    expect(
      events
        .filter((e) => e.ruleId === 'status.resource-pulse')
        .map((e) => [e.step, e.reason, e.amount]),
    ).toEqual([
      [0, 'mp:decrease', 30],
      [0, 'stamina:decrease', 2],
      [5, 'mp:decrease', 30],
      [10, 'mp:decrease', 20],
    ]);
    expect(events.some((e) => e.kind === 'status-remove')).toBe(false);
    const legacy = await combatManifest(6, { policy: { movement: 'hold', priorities: [] } });
    await withInitialStatus(legacy, 0, definition);
    const old = await runBattle(legacy);
    expect(JSON.stringify(old.records)).not.toContain('stamina');
  });

  it('keeps fractional recovery across expiry and makes a permanent recovery modifier last the battle', async () => {
    const adjustments: Definition<'status'>['adjustments'] = [
      { target: 'staminaRecovery', operation: 'add', amount: 2 },
      { target: 'staminaRecovery', operation: 'multiply', amount: 15000 },
    ];
    for (const permanent of [false, true]) {
      const manifest = await resourceCombat(
        { adjustments, ...(permanent && { categories: ['permanent'] }) },
        50,
        3,
      );
      const events = battleEvents((await runBattle(manifest)).records);
      const recovered = events.filter(
        (e) => e.ruleId === 'resource.stamina-recovery' && e.actorId === 'left',
      );
      expect(recovered.map((e) => e.step)).toEqual(
        permanent ? [7, 14, 20, 27, 34, 40, 47] : [7, 19, 35],
      );
      expect(recovered.at(-1)?.after?.stamina).toBe(permanent ? 9 : 5);
      expect(events.some((e) => e.kind === 'status-remove')).toBe(!permanent);
    }
  });

  it('uses the interval-start modifier when a water hit removes it at the interval end', async () => {
    const f = await aiFixture({
      steps: 8,
      character: { stamina: { max: 20, recoveryPerSecond: 50 } },
      abilities: [
        {
          castSteps: 0,
          costs: { hp: 0, mp: 0, uses: 1 },
          effects: [{ kind: 'damage', amount: 25, attackScaleBps: 0, element: 'water' }],
        },
        {
          trigger: 'battle-start',
          target: 'self',
          attack: { kind: 'direct' },
          castSteps: 0,
          costs: { hp: 0, mp: 0, stamina: 10, uses: 1 },
          effects: [{ kind: 'shield', amount: 1 }],
        },
      ],
    });
    f.world.free();
    await withInitialStatus(
      f.manifest,
      1,
      initialStatus({
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
        adjustments: [{ target: 'staminaRecovery', operation: 'multiply', amount: 0 }],
      }),
    );
    const events = battleEvents((await runBattle(f.manifest)).records);
    expect(events.find((e) => e.ruleId === 'status.reaction')).toMatchObject({ step: 6 });
    expect(
      events
        .filter((e) => e.ruleId === 'resource.stamina-recovery' && e.actorId === 'right')
        .map((e) => [e.step, e.after?.stamina]),
    ).toEqual([
      [7, 11],
      [8, 12],
    ]);
  });

  it('values resource states from own definitions, excludes missing resources and records only coarse public benefit', async () => {
    const f = await aiFixture({ character: { stamina: { max: 10, recoveryPerSecond: 1 } } });
    try {
      const status = await withInitialStatus(
        f.manifest,
        0,
        initialStatus({
          visibility: 'visible',
          periodic: [{ kind: 'resource', resource: 'stamina', amount: 5, everySteps: 5 }],
        }),
      );
      const battle = await prepareBattle(f.manifest);
      const view = { ...f.view, self: { ...f.self, actor: battle.actors[0] } };
      const effect = { kind: 'apply-status' as const, status: reference(status) };
      expect(assessStatusEffect(view, effect, 'self')).toMatchObject({ handled: true, value: 2 });
      expect(assessStatusEffect(view, effect, 'enemy').value).toBe(-2);
      const { stamina: _, ...legacyCharacter } = view.self.actor.character;
      expect(
        assessStatusEffect(
          {
            ...view,
            self: { ...view.self, actor: { ...view.self.actor, character: legacyCharacter } },
          },
          effect,
          'self',
        ).value,
      ).toBe(0);
      const events = battleEvents((await runBattle(f.manifest)).records);
      const summaries = events.flatMap((e) =>
        e.actorId === 'right' && e.cognition?.kind === 'knowledge'
          ? (e.cognition.statusObservation?.statuses ?? [])
          : [],
      );
      expect(summaries).toContainEqual({
        id: status.id,
        categories: [],
        removable: true,
        benefit: 'beneficial',
        reactions: [],
      });
    } finally {
      f.world.free();
    }
  });
});
