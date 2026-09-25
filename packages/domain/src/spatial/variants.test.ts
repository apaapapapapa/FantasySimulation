import { expect, it } from 'vite-plus/test';
import { matchAttack, matchEffect, type AttackHandlers, type EffectHandlers } from './variants.ts';

it('dispatches narrowed variants with caller context and requires complete registrations', () => {
  const attacks: AttackHandlers<number, number> = {
    direct: (_shape, n) => n,
    arc: (shape, n) => shape.reachMm + n,
    radial: (shape, n) => shape.bladeRadiusMm + n,
    hitscan: (shape, n) => shape.radiusMm + n,
    melee: (shape, n) => shape.activeSteps + n,
    projectile: (shape, n) => shape.lifetimeSteps + n,
  };
  expect(matchAttack({ kind: 'hitscan', radiusMm: 37 }, attacks, 5)).toBe(42);
  // @ts-expect-error A new kind cannot be silently inherited by an old registry.
  const extended: AttackHandlers<number, number> & {
    future: (shape: { kind: 'future' }, n: number) => number;
  } = attacks;
  void extended;
  // @ts-expect-error An incomplete registration must fail the canonical TypeScript gate.
  const incomplete: EffectHandlers<undefined, number> = { damage: (effect) => effect.amount };
  void incomplete;
  const effects: EffectHandlers<number, number> = {
    damage: (effect, n) => effect.amount + n,
    heal: (effect, n) => effect.amount + n,
    shield: (effect, n) => effect.amount + n,
    force: (effect, n) => effect.durationSteps + n,
    reveal: (effect, n) => effect.delaySteps + n,
    water: (_effect, n) => n,
    dispel: (_effect, n) => n,
    'apply-status': (_effect, n) => n,
  };
  expect(matchEffect({ kind: 'heal', amount: 12 }, effects, 3)).toBe(15);
});
