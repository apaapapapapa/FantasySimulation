import { describe, expect, it } from 'vite-plus/test';
import { CharacterSchema, EffectSchema } from '@fantasy/domain/spatial';
import fixtures from '../../fixtures/spatial/damage-formulas.json';
import { calculateDamage } from './damage.ts';
import { prepareBattle, sealRevision } from './prepare.ts';
import { sampleManifest } from './sample.ts';
import { applyStatuses, effectiveStats } from './status.ts';
import { resolveEffects, type EffectApplication } from './effects.ts';
import { initialStatus } from '../../test-support/ai.ts';

describe('damage formula contract (G-02)', () => {
  it.each(fixtures)('$name', (fixture) => {
    const effect = EffectSchema.parse(fixture.effect);
    if (effect.kind !== 'damage') throw Error('Expected damage fixture');
    const result = calculateDamage(
      effect,
      fixture.source,
      fixture.target,
      fixture.coverage,
      fixture.modifiers,
    );
    expect(
      JSON.parse(
        JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? String(value) : value)),
      ),
    ).toEqual(fixture.expected);
  });
  it('validates optional stats and formula terms without materializing legacy defaults', async () => {
    const manifest = await sampleManifest();
    const character = manifest.revisions.find((r) => r.kind === 'character')!.definition;
    expect(CharacterSchema.parse(character)).toEqual(character);
    expect(EffectSchema.parse(fixtures[0]!.effect)).toEqual(fixtures[0]!.effect);
    for (const edit of [
      { defense: 'holy' },
      { scaling: [] },
      { scaling: [{ stat: 'hp', ratioBps: 10000 }] },
      { scaling: [{ stat: 'magicPower', ratioBps: -1 }] },
      { scaling: [{ stat: 'magicPower', ratioBps: 100001 }] },
      {
        scaling: [
          { stat: 'attack', ratioBps: 1 },
          { stat: 'attack', ratioBps: 2 },
        ],
      },
    ])
      expect(EffectSchema.safeParse({ ...fixtures[0]!.effect, ...edit }).success).toBe(false);
    for (const stat of ['magicPower', 'magicDefense']) {
      for (const value of [-1, 1.5, 1000001]) {
        expect(
          CharacterSchema.safeParse({ ...character, stats: { ...character.stats, [stat]: value } })
            .success,
        ).toBe(false);
      }
      expect(
        CharacterSchema.safeParse({ ...character, stats: { ...character.stats, [stat]: 0 } })
          .success,
      ).toBe(true);
    }
  });
  it('uses effective physical stats only when magic stats are absent', async () => {
    const battle = await prepareBattle(await sampleManifest());
    const actor = battle.actors[0];
    const aura = await sealRevision(
      'status',
      'power',
      1,
      initialStatus({
        modifiers: {
          attack: 10,
          defense: 20,
          speedBps: 10000,
          flight: false,
          rooted: false,
        },
      }),
    );
    const statuses = applyStatuses([], [{ revision: aura, cause: 'aura' }], [], 0).statuses;
    const stats = effectiveStats(actor, statuses, 0);
    const effect = EffectSchema.parse(fixtures[1]!.effect);
    if (effect.kind !== 'damage') throw Error('Expected damage');
    expect(calculateDamage(effect, stats, { ...stats, resistance: 0 }).afterModifiers).toBe(35n);
    const explicit = effectiveStats(
      {
        ...actor,
        character: {
          ...actor.character,
          stats: { ...actor.character.stats, magicPower: 0, magicDefense: 0 },
        },
      },
      statuses,
      0,
    );
    expect(calculateDamage(effect, explicit, { ...explicit, resistance: 0 }).afterModifiers).toBe(
      0n,
    );
  });
  it('resolves mixed components against one shield with exact order-independent attribution', async () => {
    const battle = await prepareBattle(await sampleManifest());
    const actor = battle.actors[0];
    const target = {
      actor: {
        ...actor,
        character: {
          ...actor.character,
          stats: {
            ...actor.character.stats,
            magicDefense: 12,
            resistances: { ...actor.character.stats.resistances, fire: 2500 },
          },
        },
      },
      resources: { hp: 100, mp: 100, shield: 7 },
      statuses: [],
    };
    const apps: EffectApplication[] = [
      {
        id: 'blade',
        actorId: 'right',
        targetId: 'left',
        attack: 20,
        magicPower: 40,
        effect: {
          kind: 'damage',
          amount: 3,
          attackScaleBps: 0,
          element: 'physical',
          defense: 'physical',
          scaling: [
            { stat: 'attack', ratioBps: 5000 },
            { stat: 'magicPower', ratioBps: 2500 },
          ],
        },
      },
      {
        id: 'flame',
        actorId: 'right',
        targetId: 'left',
        attack: 20,
        magicPower: 40,
        effect: {
          kind: 'damage',
          amount: 2,
          attackScaleBps: 0,
          element: 'fire',
          defense: 'magic',
          scaling: [
            { stat: 'attack', ratioBps: 2500 },
            { stat: 'magicPower', ratioBps: 5000 },
          ],
        },
      },
    ];
    const result = resolveEffects([target], apps, [], 0);
    expect(result[0]!.resources).toEqual({ hp: 78, mp: 100, shield: 0 });
    expect(
      result[0]!.damage.map((d) => [
        d.defenseApplied,
        d.afterResistance,
        d.absorbed,
        d.calculation?.component,
      ]),
    ).toEqual([
      [5, 18, { numerator: '126', denominator: '29' }, 'physical'],
      [12, 11, { numerator: '77', denominator: '29' }, 'elemental'],
    ]);
    expect(resolveEffects([target], [...apps].reverse(), [], 0)).toEqual(result);
  });
});
