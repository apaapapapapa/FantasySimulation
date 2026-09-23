import { describe, expect, it } from 'vite-plus/test';
import type { Definition } from '@fantasy/domain/spatial';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { sampleManifest } from './sample.ts';
import { fraction, resolveEffects, type EffectApplication, type EffectTarget } from './effects.ts';
import { applyStatuses, effectiveStats, statusBoundary, UnresolvedRuleError } from './status.ts';
async function targets() {
  const battle = await prepareBattle(await sampleManifest());
  return battle.actors.map((actor): EffectTarget => ({
    actor,
    resources: { hp: actor.character.stats.hp, mp: actor.character.stats.mp, shield: 0 },
    statuses: [],
  }));
}
const damage = (id: string, amount: number, targetId = 'left'): EffectApplication => ({
  id,
  actorId: 'right',
  targetId,
  attack: 0,
  effect: { kind: 'damage', amount, attackScaleBps: 0, element: 'physical' },
});
const definition = (stacking: Definition<'status'>['stacking'] = 'sum'): Definition<'status'> => ({
  name: 'test',
  originalText: 'fixture',
  stackKey: 'test',
  stacking,
  maxStacks: 3,
  durationSteps: 3,
  modifiers: { attack: 2, defense: 3, speedBps: 12000, flight: true, rooted: false },
  periodic: [{ kind: 'damage', amount: 4, element: 'fire', everySteps: 2 }],
});
describe('simultaneous effects', () => {
  it('water removes only existing extinguishable burning while simultaneous new burning remains', async () => {
    const states = await targets();
    const burn = await sealRevision('status', 'ordinary-burn', 1, {
      ...definition('refresh'),
      burning: { waterExtinguishable: true },
    });
    const magic = await sealRevision('status', 'magic-burn', 1, {
      ...definition('refresh'),
      stackKey: 'magic',
      burning: { waterExtinguishable: false },
    });
    states[0]!.statuses = [burn, magic].map((revision) => ({
      revision,
      startStep: 0,
      endStep: 3,
      stacks: 1,
      causes: ['prior'],
    }));
    const water: EffectApplication = {
      id: 'water',
      actorId: 'left',
      targetId: 'left',
      attack: 0,
      effect: { kind: 'water', extinguish: true },
    };
    const ignition: EffectApplication = {
      id: 'ignite',
      actorId: 'right',
      targetId: 'left',
      attack: 0,
      effect: { kind: 'apply-status', status: reference(burn) },
    };
    const result = resolveEffects(states, [water, ignition], [burn, magic], 0, 1)[0]!;
    expect(result.statuses.map((s) => [s.revision.id, s.startStep])).toEqual([
      ['magic-burn', 0],
      ['ordinary-burn', 1],
    ]);
    expect(result.resources).toEqual(states[0]!.resources);
    expect(resolveEffects(states, [ignition, water], [burn, magic], 0, 1)).toEqual(
      resolveEffects(states, [water, ignition], [burn, magic], 0, 1),
    );
    expect(states[0]!.statuses.every((s) => s.startStep === 0)).toBe(true);
  });
  it('aggregates healing and damage before clamping, including HP already spent as a legal self-cost', async () => {
    const states = await targets();
    states[0]!.resources.hp = 10;
    const apps: EffectApplication[] = [
      damage('damage', 20),
      {
        id: 'heal',
        actorId: 'left',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'heal', amount: 20 },
      },
    ];
    expect(resolveEffects(states, apps, [], 0)[0]!.resources.hp).toBe(15);
    states[0]!.resources.hp = 100;
    expect(resolveEffects(states, apps, [], 0)[0]!.resources.hp).toBe(100);
    states[0]!.resources.hp = 0;
    expect(resolveEffects(states, [apps[1]!], [], 0)[0]!.resources.hp).toBe(20);
    expect(states[0]!.resources.hp).toBe(0);
  });
  it('applies defense, resistance and a shared shield without allocating remainders by order', async () => {
    const states = await targets();
    states[0]!.resources.shield = 1;
    const apps = [damage('one', 6), damage('two', 7)]; // defense 5 => 1 and 2
    const result = resolveEffects(states, apps, [], 0);
    expect(result[0]!.resources).toEqual({ hp: 98, mp: states[0]!.resources.mp, shield: 0 });
    expect(result[0]!.damage.map((d) => d.absorbed)).toEqual([fraction(1n, 3n), fraction(2n, 3n)]);
    expect(result[0]!.damage.map((d) => d.toHp)).toEqual([fraction(2n, 3n), fraction(4n, 3n)]);
    expect(resolveEffects([...states].reverse(), [...apps].reverse(), [], 0)).toEqual(result);
    expect(states[0]!.resources.shield).toBe(1);
    const actor = states[0]!.actor;
    states[0]!.actor = {
      ...actor,
      character: {
        ...actor.character,
        stats: {
          ...actor.character.stats,
          resistances: { ...actor.character.stats.resistances, physical: 5000 },
        },
      },
    };
    expect(resolveEffects(states, [damage('hit', 26)], [], 0)[0]!.damage[0]).toMatchObject({
      afterDefense: 21,
      afterResistance: 10,
      toHp: fraction(9n, 1n),
    });
  });
  it('combines shields granted in the same interval and preserves simultaneous lethal effects', async () => {
    const states = await targets();
    const apps: EffectApplication[] = [
      damage('a', 205),
      damage('b', 205, 'right'),
      {
        id: 'shield',
        actorId: 'left',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'shield', amount: 30 },
      },
    ];
    const result = resolveEffects(states, apps, [], 0);
    expect(result.map((r) => r.resources.hp)).toEqual([0, 0]);
    expect(result[0]!.shieldAbsorbed).toBe(30);
    expect(result[0]!.hpDamage).toBe(170);
  });
  it('uses exact integer intermediates, coverage and nonnegative reduced fractions', async () => {
    const states = await targets();
    const app = {
      ...damage('big', 1_000_000),
      attack: 205_800_000,
      effect: {
        kind: 'damage' as const,
        amount: 1_000_000,
        attackScaleBps: 100_000,
        element: 'physical' as const,
      },
      scaleBps: 3333,
    };
    const result = resolveEffects(states, [app], [], 0)[0]!;
    expect(result.damage[0]!.afterDefense).toBe(Number(((2059000000n - 5n) * 3333n) / 10000n));
    expect(result.resources.hp).toBe(0);
    expect(fraction(0n, 33n)).toEqual({ numerator: '0', denominator: '1' });
    expect(fraction(9007199254740993n, 3n)).toEqual({
      numerator: '3002399751580331',
      denominator: '1',
    });
    expect(() => fraction(1n, 0n)).toThrow('Invalid nonnegative fraction');
  });
  it('activates new status modifiers at the next boundary and resolves simultaneous dispel against existing cohorts only', async () => {
    const states = await targets(),
      status = await sealRevision('status', 'aura', 1, definition());
    states[0]!.statuses = applyStatuses([], [{ revision: status, cause: 'old' }], [], 0).statuses;
    const apps: EffectApplication[] = [
      damage('hit', 20),
      {
        id: 'apply',
        actorId: 'left',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'apply-status', status: reference(status) },
      },
      {
        id: 'remove',
        actorId: 'right',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'dispel', statusIds: ['aura'] },
      },
    ];
    const result = resolveEffects(states, apps, [status], 0)[0]!;
    expect(result.damage[0]!.afterDefense).toBe(12); // old defense 5+3
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]).toMatchObject({
      startStep: 1,
      endStep: 4,
      stacks: 1,
      causes: ['apply'],
    });
    expect(effectiveStats(states[0]!.actor, result.statuses, 0).flight).toBe(false);
    expect(effectiveStats(states[0]!.actor, result.statuses, 1).flight).toBe(true);
    expect(effectiveStats(states[0]!.actor, result.statuses, 4).flight).toBe(false);
  });
});
describe('status lifetime and stacking', () => {
  it('pulses at activation, excludes expiry, and allows a replacement cohort exactly at expiry', async () => {
    const revision = await sealRevision('status', 'aura', 1, definition('reject'));
    const initial = applyStatuses([], [{ revision, cause: 'apply' }], [], 1).statuses;
    expect(statusBoundary(initial, 0).pulses).toHaveLength(0);
    expect(statusBoundary(initial, 1).pulses).toHaveLength(1);
    expect(statusBoundary(initial, 2).pulses).toHaveLength(0);
    expect(statusBoundary(initial, 3).pulses).toHaveLength(1);
    expect(statusBoundary(initial, 4).pulses).toHaveLength(0);
    expect(statusBoundary(initial, 4).removed).toHaveLength(1);
    expect(applyStatuses(initial, [{ revision, cause: 'again' }], [], 4).statuses[0]).toMatchObject(
      { startStep: 4, endStep: 7, causes: ['again'] },
    );
  });
  it('caps sums as a shared simultaneous cohort and preserves independent expiry times', async () => {
    const revision = await sealRevision('status', 'aura', 1, definition());
    const incoming = ['a', 'b', 'c', 'd'].map((cause) => ({ revision, cause }));
    const first = applyStatuses([], incoming, [], 1);
    expect(first.statuses[0]).toMatchObject({ stacks: 3, causes: ['a', 'b', 'c', 'd'] });
    expect(applyStatuses([], [...incoming].reverse(), [], 1)).toEqual(first);
    const initial = applyStatuses([], [incoming[0]!], [], 1).statuses;
    const next = applyStatuses(initial, [incoming[1]!], [], 2).statuses;
    expect(next.map((s) => [s.startStep, s.endStep, s.stacks])).toEqual([
      [1, 4, 1],
      [2, 5, 1],
    ]);
    expect(statusBoundary(next, 4).statuses).toHaveLength(1);
    expect(initial[0]!.stacks).toBe(1);
  });
  it('refreshes the end without moving periodic phase, and replaces or rejects explicitly', async () => {
    for (const mode of ['refresh', 'replace', 'reject'] as const) {
      const revision = await sealRevision('status', 'aura', 1, definition(mode));
      const initial = applyStatuses([], [{ revision, cause: 'first' }], [], 1).statuses;
      const result = applyStatuses(initial, [{ revision, cause: 'next' }], [], 2).statuses;
      expect(result).toHaveLength(1);
      expect(result[0]!.startStep).toBe(mode === 'replace' ? 2 : 1);
      expect(result[0]!.endStep).toBe(mode === 'reject' ? 4 : 5);
    }
  });
  it('reports status budget exhaustion and succeeds with larger attempt limits without changing definitions', async () => {
    const a = await sealRevision('status', 'aura', 1, definition());
    const b = await sealRevision('status', 'ward', 1, { ...definition(), stackKey: 'ward' });
    const incoming = [
      { revision: a, cause: 'a' },
      { revision: b, cause: 'b' },
    ];
    expect(() =>
      applyStatuses([], incoming, [], 1, { maxStatusTypes: 1, maxStatusCauses: 4 }),
    ).toThrow('active-statuses');
    expect(
      applyStatuses([], incoming, [], 1, { maxStatusTypes: 2, maxStatusCauses: 4 }).statuses,
    ).toHaveLength(2);
    expect(() =>
      applyStatuses([], incoming, [], 1, { maxStatusTypes: 2, maxStatusCauses: 1 }),
    ).toThrow('status-causes');
    const actor = (await targets())[0]!.actor;
    const statuses = applyStatuses([], incoming, [], 1).statuses;
    const active = effectiveStats(actor, statuses, 1);
    expect(active).toMatchObject({
      attack: actor.character.stats.attack + 4,
      defense: actor.character.stats.defense + 6,
      speedBps: 14000,
      flight: true,
    });
    expect(effectiveStats(actor, statuses, 4).flight).toBe(false);
  });
  it('preserves original and refresh causes for later pulses and charges their cumulative budget', async () => {
    const revision = await sealRevision('status', 'aura', 1, definition('refresh'));
    const initial = applyStatuses([], [{ revision, cause: 'original' }], [], 1).statuses;
    const refreshed = applyStatuses(initial, [{ revision, cause: 'refresh' }], [], 2);
    expect(refreshed.statuses[0]!.causes).toEqual(['original', 'refresh']);
    expect(refreshed.changes[0]!.causes).toEqual(['refresh']);
    expect(statusBoundary(refreshed.statuses, 3).pulses[0]!.causes).toEqual([
      'original',
      'refresh',
    ]);
    expect(initial[0]!.causes).toEqual(['original']);
    expect(() =>
      applyStatuses(refreshed.statuses, [{ revision, cause: 'third' }], [], 3, {
        maxStatusTypes: 1,
        maxStatusCauses: 2,
      }),
    ).toThrow('status-causes');
    expect(
      applyStatuses(refreshed.statuses, [{ revision, cause: 'third' }], [], 3, {
        maxStatusTypes: 1,
        maxStatusCauses: 3,
      }).statuses[0]!.causes,
    ).toEqual(['original', 'refresh', 'third']);
  });
  it('reports conflicting accepted definitions as unresolved and leaves both inputs untouched', async () => {
    const a = await sealRevision('status', 'aura', 1, definition('replace'));
    const b = await sealRevision('status', 'other', 1, {
      ...definition('replace'),
      modifiers: { ...definition().modifiers, defense: 8 },
    });
    const incoming = [
      { revision: a, cause: 'a' },
      { revision: b, cause: 'b' },
    ];
    expect(() => applyStatuses([], incoming, [], 1)).toThrow(UnresolvedRuleError);
    expect(() => applyStatuses([], [...incoming].reverse(), [], 1)).toThrow(
      'Different simultaneous definitions',
    );
    const states = await targets(),
      before = structuredClone(states);
    const apps: EffectApplication[] = incoming.map((x) => ({
      id: x.cause,
      actorId: 'left',
      targetId: 'left',
      attack: 0,
      effect: { kind: 'apply-status', status: reference(x.revision) },
    }));
    expect(() => resolveEffects(states, apps, [a, b], 0)).toThrow(UnresolvedRuleError);
    expect(states).toEqual(before);
  });
});
