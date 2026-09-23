import { describe, expect, it } from 'vite-plus/test';
import { StatusSchema, type Definition } from '@fantasy/domain/spatial';
import { initialStatus } from '../../test-support/ai.ts';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { sampleManifest } from './sample.ts';
import { resolveEffects, type EffectApplication, type EffectTarget } from './effects.ts';
import { applyStatuses, effectiveStats, statusBoundary, UnresolvedRuleError } from './status.ts';

async function generalizedState(edits: Partial<Definition<'status'>>[] = [{}]) {
  const battle = await prepareBattle(await sampleManifest());
  const revisions = await Promise.all(
    edits.map((edit, i) =>
      sealRevision(
        'status',
        `state-${i}`,
        1,
        initialStatus({ stackKey: `state-${i}`, durationSteps: 10, ...edit }),
      ),
    ),
  );
  const actor = battle.actors[0];
  const target: EffectTarget = {
    actor,
    resources: { hp: 100, mp: 100, shield: 0 },
    statuses: revisions.map((revision) => ({
      revision,
      startStep: 0,
      endStep: 10,
      stacks: 1,
      causes: ['prior'],
    })),
  };
  const contact = (
    id: string,
    element: Extract<EffectApplication['effect'], { kind: 'damage' }>['element'],
    amount = 25,
  ): EffectApplication => ({
    id,
    actorId: 'right',
    targetId: 'left',
    attack: 0,
    effect: { kind: 'damage', amount, attackScaleBps: 0, element },
  });
  const resolve = (apps: EffectApplication[], step = 2) =>
    resolveEffects([target], apps, revisions, step, step + 1)[0]!;
  return { target, revisions, contact, resolve };
}

describe('G-03 data-defined status resolution', () => {
  it.each([true, false])(
    'adapts old burning on water damage, including zero HP damage (%s)',
    async (extinguishable) => {
      const f = await generalizedState([{ burning: { waterExtinguishable: extinguishable } }]);
      const result = f.resolve([f.contact('water-hit', 'water', 0)]);
      expect(result.resources.hp).toBe(100);
      expect(result.statuses).toHaveLength(extinguishable ? 0 : 1);
    },
  );

  it('lets an explicit water response override the legacy flag and never reacts at zero coverage', async () => {
    const f = await generalizedState([
      {
        burning: { waterExtinguishable: true },
        reactions: [{ element: 'water', response: { kind: 'none' } }],
      },
      {
        burning: { waterExtinguishable: false },
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
      },
    ]);
    expect(f.resolve([f.contact('water', 'water')]).statuses.map((s) => s.revision.id)).toEqual([
      'state-0',
    ]);
    expect(f.resolve([{ ...f.contact('miss', 'water'), scaleBps: 0 }]).statuses).toHaveLength(2);
  });

  it('strengthens once per contacted element across duplicate components and legacy water', async () => {
    const f = await generalizedState([
      {
        stacking: 'sum',
        maxStacks: 4,
        reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 2 } }],
      },
    ]);
    const apps: EffectApplication[] = [
      f.contact('one', 'water'),
      f.contact('two', 'water'),
      {
        id: 'old-water',
        actorId: 'left',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'water', extinguish: true },
      },
    ];
    const result = f.resolve(apps);
    expect(result.statuses[0]).toMatchObject({ startStep: 0, endStep: 10, stacks: 3 });
    expect(f.resolve([...apps].reverse())).toEqual(result);
    expect(f.target.statuses[0]!.stacks).toBe(1);
  });

  it('transforms only the old snapshot and leaves the newly created water-reactive state active', async () => {
    const frozen = await sealRevision(
      'status',
      'frozen',
      1,
      initialStatus({
        stackKey: 'frozen',
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
      }),
    );
    const f = await generalizedState([
      {
        reactions: [
          { element: 'water', response: { kind: 'transform', status: reference(frozen) } },
        ],
      },
    ]);
    f.revisions.push(frozen);
    const result = f.resolve([f.contact('water', 'water')]);
    expect(result.statuses.map((s) => [s.revision.id, s.startStep])).toEqual([['frozen', 3]]);
    expect(result.changes.filter((c) => c.kind === 'remove').map((c) => c.revision.id)).toEqual([
      'state-0',
    ]);
  });

  it('rejects ambiguous transformations without using attribute or input order as priority', async () => {
    const next = await sealRevision('status', 'transformed', 1, initialStatus());
    const f = await generalizedState([
      {
        reactions: [
          { element: 'water', response: { kind: 'remove' } },
          { element: 'ice', response: { kind: 'transform', status: reference(next) } },
        ],
      },
    ]);
    f.revisions.push(next);
    const apps = [f.contact('water', 'water'), f.contact('ice', 'ice')];
    expect(() => f.resolve(apps)).toThrow(UnresolvedRuleError);
    expect(() => f.resolve(apps.reverse())).toThrow(UnresolvedRuleError);
  });

  it('applies temporary elemental weakness to the removing hit and restores damage after expiry', async () => {
    const f = await generalizedState([
      {
        reactions: [{ element: 'lightning', response: { kind: 'remove' }, damageTakenBps: 15000 }],
      },
    ]);
    const hit = f.contact('shock', 'lightning');
    expect(f.resolve([hit]).resources.hp).toBe(70); // (25 - 5) * 1.5
    expect(f.resolve([hit]).statuses).toHaveLength(0);
    expect(f.resolve([hit], 10).resources.hp).toBe(80);
  });

  it('uses additive-then-Bps adjustments with the legacy modifiers and deterministic bounds', async () => {
    const f = await generalizedState([
      {
        modifiers: { attack: 3, defense: 0, speedBps: 12000, flight: false, rooted: false },
        adjustments: [
          { target: 'attack', operation: 'add', amount: 4 },
          { target: 'attack', operation: 'multiply', amount: 12000 },
          { target: 'resistance', element: 'fire', operation: 'add', amount: 2500 },
        ],
      },
    ]);
    f.target.statuses[0]!.stacks = 2;
    const stats = effectiveStats(f.target.actor, f.target.statuses, 2);
    expect(stats.attack).toBe(47); // floor((20 + 6 + 8) * 1.4)
    expect(stats.speedBps).toBe(14000);
    expect(f.resolve([f.contact('fire', 'fire')]).resources.hp).toBe(90); // defense 5, resistance 50%
    expect(effectiveStats(f.target.actor, f.target.statuses, 10).attack).toBe(20);
  });

  it('adjusts independent magic stats and records the actual modified recovery before the shared HP clamp', async () => {
    const f = await generalizedState([
      {
        adjustments: [
          { target: 'magicPower', operation: 'add', amount: 5 },
          { target: 'magicPower', operation: 'multiply', amount: 20000 },
          { target: 'magicDefense', operation: 'add', amount: 7 },
          { target: 'hpRecovery', operation: 'multiply', amount: 15000 },
        ],
      },
    ]);
    f.target.actor = {
      ...f.target.actor,
      character: {
        ...f.target.actor.character,
        stats: { ...f.target.actor.character.stats, magicPower: 12, magicDefense: 0 },
      },
    };
    expect(effectiveStats(f.target.actor, f.target.statuses, 2)).toMatchObject({
      attack: 20,
      defense: 5,
      magicPower: 34,
      magicDefense: 7,
    });
    f.target.resources.hp = 50;
    const healed = f.resolve([
      {
        id: 'heal',
        actorId: 'left',
        targetId: 'left',
        attack: 0,
        scaleBps: 5000,
        effect: { kind: 'heal', amount: 8 },
      },
    ]);
    expect(healed).toMatchObject({
      resources: { hp: 56 },
      healed: 6,
      healing: [{ applicationId: 'heal', amount: 6 }],
    });
    expect(effectiveStats(f.target.actor, f.target.statuses, 10)).toMatchObject({
      magicPower: 12,
      magicDefense: 0,
    });
  });

  it('retains permanent effects across their nominal expiry, ID/category/water removal and replacement', async () => {
    const f = await generalizedState([
      {
        categories: ['buff', 'permanent'],
        burning: { waterExtinguishable: true },
        periodic: [{ kind: 'heal', amount: 1, element: 'physical', everySteps: 2 }],
      },
    ]);
    const old = f.target.statuses[0]!;
    const applied = applyStatuses([], [{ revision: old.revision, cause: 'startup' }], [], 0);
    expect(statusBoundary(applied.statuses, 10).pulses).toHaveLength(1);
    expect(statusBoundary(applied.statuses, 10).removed).toHaveLength(0);
    f.target.statuses = applied.statuses;
    const attempts: EffectApplication[] = [
      {
        id: 'by-id',
        actorId: 'right',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'dispel', statusIds: ['state-0'] },
      },
      {
        id: 'by-tag',
        actorId: 'right',
        targetId: 'left',
        attack: 0,
        effect: { kind: 'dispel', categories: ['buff'] },
      },
      f.contact('water', 'water'),
    ];
    expect(f.resolve(attempts, 11).statuses).toHaveLength(1);
    const replacement = await sealRevision(
      'status',
      'replacement',
      1,
      initialStatus({ stackKey: 'state-0', stacking: 'replace' }),
    );
    expect(() =>
      applyStatuses(applied.statuses, [{ revision: replacement, cause: 'new' }], [], 12),
    ).toThrow(UnresolvedRuleError);
  });
});

describe('G-03 strict optional schema fields', () => {
  it.each([
    { adjustments: [{ target: 'unsupported', operation: 'add', amount: 1 }] },
    { adjustments: [{ target: 'resistance', operation: 'add', amount: 1 }] },
    { adjustments: [{ target: 'attack', operation: 'multiply', amount: -1 }] },
    { adjustments: [{ target: 'defense', operation: 'add', amount: 1, category: 'physical' }] },
    {
      reactions: [
        { element: 'water', response: { kind: 'remove' } },
        { element: 'water', response: { kind: 'none' } },
      ],
    },
    { reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 0 } }] },
  ])('rejects invalid extension %j', (edit) => {
    expect(StatusSchema.safeParse({ ...initialStatus(), ...edit }).success).toBe(false);
  });
});
