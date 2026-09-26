import { expect, it } from 'vite-plus/test';
import { EffectSchema, StatusAdjustmentSchema, closureMechanics } from '@fantasy/domain/spatial';
import { resolveEffects } from './rules/effects.ts';
import { copyDamageSnapshot } from './rules/status-damage.ts';
import {
  absorption,
  recoveryApplication as app,
  recoveryDamage as damage,
  recoveryManifest,
  recoveryTargets,
} from '../../test-support/recovery.ts';

it('validates bounded additive elemental absorption and optional damage drain through closure', async () => {
  expect(StatusAdjustmentSchema.parse(absorption(10000))).toEqual(absorption(10000));
  for (const edit of [
    { amount: -1 },
    { amount: 10001 },
    { amount: 0.5 },
    { operation: 'multiply' },
    { element: undefined },
    { category: 'magic' },
  ])
    expect(StatusAdjustmentSchema.safeParse({ ...absorption(5000), ...edit }).success).toBe(false);
  for (const bps of [-1, 10001, 0.5])
    expect(EffectSchema.safeParse(damage(1, bps)).success).toBe(false);
  expect(EffectSchema.parse(damage(1))).not.toHaveProperty('drainBps');
  expect(closureMechanics((await recoveryManifest()).revisions).map((m) => m.mechanic)).toEqual(
    expect.arrayContaining(['drain', 'attribute-absorption']),
  );
});

it('converts after taken multipliers before shared shield and keeps the single wave clamp', async () => {
  const targets = await recoveryTargets([
    absorption(5000),
    { target: 'damageTaken', operation: 'multiply', amount: 20000 },
  ]);
  targets[1]!.resources.shield = 5;
  const result = resolveEffects(targets, [app('hit', damage(20, 10000))], [], 0);
  // 20 -> 40 -> 20 converted, shield 5, HP loss 15; target 10 + 20 - 15 = 15.
  expect(result[1]!.resources).toMatchObject({ hp: 15, shield: 0 });
  expect(result[0]!.resources.hp).toBe(25);
  expect(result[1]!.damage[0]).toMatchObject({
    absorption: { element: 'fire', converted: 20, healing: 20 },
    absorbed: { numerator: '5', denominator: '1' },
    toHp: { numerator: '15', denominator: '1' },
    drain: { basis: { numerator: '15', denominator: '1' }, healing: 15 },
  });
});

it('sums absorption to 100 percent and scales its healing without consuming shield or feeding drain', async () => {
  const targets = await recoveryTargets([
    absorption(7000),
    absorption(6000),
    { target: 'hpRecovery', operation: 'multiply', amount: 5000 },
  ]);
  targets[1]!.resources.shield = 5;
  const result = resolveEffects(targets, [app('hit', damage(21, 10000))], [], 0);
  expect(result[1]!.resources).toMatchObject({ hp: 20, shield: 5 });
  expect(result[0]!.resources.hp).toBe(10);
  expect(result[1]!.damage[0]).toMatchObject({
    absorption: { converted: 21, healing: 10 },
    drain: { healing: 0 },
  });
});

it('caps drain by HP plus ordinary same-wave healing and floors each exact proportional share once', async () => {
  const targets = await recoveryTargets();
  targets[1]!.resources = { hp: 2, mp: 50, shield: 1 };
  const applications = [
    app('small', damage(2, 10000)),
    app('large', damage(5, 10000)),
    app('heal', { kind: 'heal', amount: 3 }),
  ];
  const result = resolveEffects(targets, applications, [], 0);
  expect(result[1]!.damage).toMatchObject([
    { applicationId: 'large', drain: { basis: { numerator: '25', denominator: '7' }, healing: 3 } },
    { applicationId: 'small', drain: { basis: { numerator: '10', denominator: '7' }, healing: 1 } },
  ]);
  expect(result.map((r) => r.resources.hp)).toEqual([14, 0]);
  expect(resolveEffects([...targets].reverse(), [...applications].reverse(), [], 0)).toEqual(
    result,
  );
});

it('lets drain survive mutual damage before defeat and never recursively funds reciprocal drain', async () => {
  const targets = await recoveryTargets();
  const result = resolveEffects(
    targets,
    [app('left', damage(10, 10000)), app('right', damage(10), 'left')],
    [],
    0,
  );
  expect(result.map((r) => r.resources.hp)).toEqual([10, 0]);
  const mutual = [app('left', damage(20, 10000)), app('right', damage(20, 10000), 'left')];
  const frozen = resolveEffects(targets, mutual, [], 0);
  expect(frozen.map((r) => r.resources.hp)).toEqual([0, 0]);
  expect(frozen.map((r) => r.damage[0]?.drain?.healing)).toEqual([10, 10]);
  expect(resolveEffects([...targets].reverse(), [...mutual].reverse(), [], 0)).toEqual(frozen);
});

it('applies source recovery to the exact drain share before its only rounding', async () => {
  const targets = await recoveryTargets([
    { target: 'hpRecovery', operation: 'multiply', amount: 30000 },
  ]);
  targets[0]!.statuses = targets[1]!.statuses;
  targets[1]!.statuses = [];
  targets[1]!.resources.hp = 2;
  targets[1]!.resources.shield = 1;
  const result = resolveEffects(
    targets,
    [app('small', damage(2, 10000)), app('large', damage(5, 10000))],
    [],
    0,
  );
  expect(result[1]!.damage.map((d) => d.drain!.healing)).toEqual([4, 1]);
  expect(result[0]!.resources.hp).toBe(15);
});

it('does not drain cancelled shielded self periodic or redirected damage and preserves the disable snapshot', async () => {
  const targets = await recoveryTargets();
  for (const edit of [
    { damageCancelled: true },
    { drainDisabled: true as const },
    { actorId: null },
    { abilityId: null },
    { actorId: 'right' },
  ]) {
    const result = resolveEffects(targets, [{ ...app('hit', damage(10, 10000)), ...edit }], [], 0);
    expect(result[0]!.resources.hp).toBe(10);
  }
  targets[1]!.resources.shield = 20;
  expect(resolveEffects(targets, [app('hit', damage(10, 10000))], [], 0)[0]!.resources.hp).toBe(10);
  expect(copyDamageSnapshot({ attack: 3, drainDisabled: true })).toEqual({
    attack: 3,
    drainDisabled: true,
  });
});

it('keeps elemental contact after conversion and applies absorption to periodic elemental damage', async () => {
  const targets = await recoveryTargets([absorption(10000)]);
  const right = targets[1]!;
  const burning = right.statuses[0]!;
  burning.revision = {
    ...burning.revision,
    definition: {
      ...burning.revision.definition,
      reactions: [{ element: 'fire', response: { kind: 'remove' } }],
    },
  };
  const result = resolveEffects(
    targets,
    [{ ...app('pulse', damage(20)), actorId: null, abilityId: null }],
    [],
    0,
  );
  expect(result[1]!.resources.hp).toBe(30);
  expect(result[1]!.statuses).toEqual([]);
  expect(result[1]!.damage[0]!.drain).toBeUndefined();
});

it('uses one final maximum HP clamp after healing and damage and respects inactive absorption', async () => {
  const targets = await recoveryTargets([absorption(5000)]);
  targets[1]!.resources.hp = 99;
  expect(
    resolveEffects(
      targets,
      [app('hit', damage(20)), app('heal', { kind: 'heal', amount: 20 })],
      [],
      0,
    )[1]!.resources.hp,
  ).toBe(100);
  targets[1]!.statuses[0]!.startStep = 1;
  expect(resolveEffects(targets, [app('hit', damage(20))], [], 0)[1]!.resources.hp).toBe(79);
});
