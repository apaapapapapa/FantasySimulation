import { describe, expect, it } from 'vite-plus/test';
import { StaminaSchema, type ResourceState } from '@fantasy/domain/spatial';
import { ResourceBudget, staminaExhausted, updateResources } from './rules/resources.ts';

const initial = () => ({ hp: 20, mp: 12, shield: 3, stamina: 10 });
const limits = { hp: 20, mp: 15, stamina: 10 };
describe('shared resource transactions', () => {
  it('sums simultaneous positive/negative deltas before a single clamp in either enumeration order', () => {
    const deltas = [
      { mp: 20, stamina: 12 },
      { mp: -18, stamina: -8, hp: -30 },
    ];
    const expected = {
      resources: { hp: 0, mp: 14, shield: 3, stamina: 10 },
      actual: { hp: -20, mp: 2, stamina: 0 },
      remainder: 0,
    };
    expect(updateResources(initial(), limits, deltas)).toEqual(expected);
    expect(updateResources(initial(), limits, [...deltas].reverse())).toEqual(expected);
    const bound = updateResources(initial(), limits, [{ hp: 100, mp: -100, stamina: -100 }]);
    expect(bound.resources).toEqual({ hp: 20, mp: 0, shield: 3, stamina: 0 });
  });
  it('carries sub-unit recovery and applies added rate before the multiplier', () => {
    let state: ResourceState = { ...initial(), stamina: 0 },
      remainder = 0;
    for (let step = 0; step < 50; step++) {
      const next = updateResources(state, limits, [], {
        perSecond: 1,
        addPerSecond: 1,
        multiplierBps: 15000,
        elapsedMs: 20,
        remainder,
      });
      state = next.resources;
      remainder = next.remainder;
      if (step === 0) expect([state.stamina, remainder]).toEqual([0, 600000]);
    }
    expect([state.stamina, remainder]).toEqual([3, 0]);
    const refill = updateResources({ ...state, stamina: 9 }, limits, [], {
      perSecond: 200,
      elapsedMs: 21,
    });
    expect([refill.resources.stamina, refill.actual.stamina, refill.remainder]).toEqual([10, 1, 0]);
  });
  it('combines recovery with a signed change and never grants negative natural recovery', () => {
    expect(
      updateResources(initial(), limits, [{ stamina: -3 }], { perSecond: 2, elapsedMs: 1000 })
        .resources.stamina,
    ).toBe(9);
    expect(
      updateResources(initial(), limits, [], { perSecond: 2, addPerSecond: -3, elapsedMs: 1000 })
        .actual.stamina,
    ).toBe(0);
    expect(() =>
      updateResources(initial(), limits, [], { perSecond: 1, elapsedMs: 1, remainder: 10000000 }),
    ).toThrow(/remainder/);
  });
  it('does not create stamina for legacy states', () => {
    const old = { hp: 20, mp: 12, shield: 3 };
    expect(
      updateResources(old, limits, [{ stamina: 100 }], { perSecond: 5, elapsedMs: 20 }).resources,
    ).toEqual(old);
    const budget = new ResourceBudget(old);
    expect(budget.reserve('charged', [{ stamina: 1 }])).toEqual({ ok: false, reason: 'stamina' });
    expect(budget.finish()).toEqual({ resources: old, used: {} });
  });
  it('rejects combined costs atomically, including a group that each could afford alone', () => {
    const budget = new ResourceBudget(initial());
    expect(
      budget.reserve('pair', [
        { hp: 1, stamina: 6 },
        { mp: 2, stamina: 6 },
      ]),
    ).toEqual({ ok: false, reason: 'stamina' });
    expect(budget.finish()).toEqual({ resources: initial(), used: {} });
    expect(budget.reserve('pair', [{ hp: 20, mp: 12, stamina: 10 }])).toEqual({ ok: true });
    budget.commit('pair');
    expect(budget.finish().resources).toEqual({ hp: 0, mp: 0, shield: 3, stamina: 0 });
  });
  it('shares held resources among movement, dodge and skills; refunds only unspent motion', () => {
    const budget = new ResourceBudget(initial());
    expect(budget.reserve('move', [{ stamina: 7 }])).toEqual({ ok: true });
    expect(budget.reserve('dodge', [{ stamina: 2 }])).toEqual({ ok: true });
    expect(
      budget.reserve('skill', [{ mp: 3, stamina: 4, uses: { id: 'spell', limit: 1 } }]),
    ).toEqual({ ok: false, reason: 'stamina' });
    expect(budget.available).toEqual({ ...initial(), stamina: 1 });
    expect(() => budget.finish()).toThrow(/Unsettled/);
    expect(() => budget.commit('move', { stamina: 8 })).toThrow(/exceeds/);
    budget.cancel('dodge');
    budget.commit('move', { stamina: 3 });
    expect(
      budget.reserve('skill', [{ mp: 3, stamina: 4, uses: { id: 'spell', limit: 1 } }]),
    ).toEqual({ ok: true });
    budget.commit('skill');
    expect(budget.finish()).toEqual({
      resources: { hp: 20, mp: 9, shield: 3, stamina: 3 },
      used: { spell: 1 },
    });
    expect(() => budget.commit('skill')).toThrow(/not pending/);
    expect(() => budget.cancel('move')).toThrow(/not pending/);
    expect(() => budget.reserve('dodge', [])).toThrow(/reused/);
  });
  it('reserves uses with the same transaction and validates consistent limits', () => {
    const budget = new ResourceBudget(initial());
    const use = { uses: { id: 'constructor', limit: 1 } };
    expect(budget.reserve('one', [use])).toEqual({ ok: true });
    expect(budget.reserve('two', [use])).toEqual({ ok: false, reason: 'uses' });
    expect(() => budget.reserve('invalid', [{ uses: { id: 'constructor', limit: 0 } }])).toThrow(
      /Inconsistent/,
    );
    budget.cancel('one');
    expect(budget.reserve('two', [use])).toEqual({ ok: true });
    budget.commit('two');
    expect(budget.finish().used).toEqual({ constructor: 1 });
    expect(
      budget.reserve('unlimited', [
        { uses: { id: 'free', limit: 0 } },
        { uses: { id: 'free', limit: 0 } },
      ]),
    ).toEqual({ ok: true });
    budget.commit('unlimited');
    expect(budget.finish().used.free).toBe(2);
  });
  it('latches exhaustion until the configured threshold while allowing zero-stamina costs', () => {
    const definition = { max: 10, recoveryPerSecond: 1, resumeAt: 4 };
    expect(staminaExhausted({ ...initial(), stamina: 0 }, definition)).toBe(true);
    expect(staminaExhausted({ ...initial(), stamina: 3 }, definition, true)).toBe(true);
    expect(staminaExhausted({ ...initial(), stamina: 4 }, definition, true)).toBe(false);
    const exhausted = new ResourceBudget(initial(), {}, false);
    expect(exhausted.reserve('tired', [{ stamina: 1 }])).toEqual({ ok: false, reason: 'stamina' });
    expect(exhausted.reserve('free', [{ mp: 1 }])).toEqual({ ok: true });
    exhausted.cancel('free');
    expect(StaminaSchema.safeParse({ ...definition, resumeAt: 11 }).success).toBe(false);
    expect(StaminaSchema.parse({ max: 10, recoveryPerSecond: 1 })).not.toHaveProperty('resumeAt');
  });
});
