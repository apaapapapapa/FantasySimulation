import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { AbilitySchema, StatusSchema, type Definition } from '@fantasy/domain/spatial';
import { abilityCategories, blockedBySilence, dispelMatchesCategory } from './categories.ts';
import { initializePhysics } from './physics.ts';
import { choosePolicy } from './policy.ts';
import { runBattle } from './run.ts';
import { sampleManifest } from './sample.ts';
import { aiFixture, initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { battleEvents } from '../../test-support/fixtures.ts';

beforeAll(async () => {
  await initializePhysics();
});
async function baseAbility(): Promise<Definition<'ability'>> {
  const ability = (await sampleManifest()).revisions.find((r) => r.kind === 'ability')!;
  if (ability.kind !== 'ability') throw new Error('Missing sample ability');
  return structuredClone(ability.definition);
}
const costs = (mp: number) => ({ hp: 0, mp, uses: 0 });
const damage = (element: 'physical' | 'fire'): Definition<'ability'>['effects'] => [
  { kind: 'damage', amount: 25, attackScaleBps: 0, element },
];
// Three designs that the old MP rule classified wrongly or not at all.
const designs: Record<string, Partial<Definition<'ability'>>> = {
  mpSword: { name: 'mp sword', categories: ['physical', 'technique'], costs: costs(4) },
  freeSpell: { name: 'free spell', categories: ['magic'], costs: costs(0) },
  magicSword: { name: 'magic sword', categories: ['physical', 'magic'], costs: costs(0) },
};

describe('ability and status categories (Issue #61 G-01)', () => {
  it('validates unique known categories and keeps category-free definitions readable', async () => {
    const ability = await baseAbility();
    expect(AbilitySchema.safeParse(ability).success).toBe(true);
    expect(AbilitySchema.safeParse({ ...ability, categories: ['physical', 'magic'] }).success).toBe(
      true,
    );
    for (const categories of [[], ['magic', 'magic'], ['holy']])
      expect(AbilitySchema.safeParse({ ...ability, categories }).success).toBe(false);
    expect(
      AbilitySchema.safeParse({ ...ability, effects: [{ kind: 'dispel' }] }).error?.issues[0]
        ?.message,
    ).toBe('Dispel requires status IDs or status categories');
    expect(
      AbilitySchema.safeParse({ ...ability, effects: [{ kind: 'dispel', categories: ['debuff'] }] })
        .success,
    ).toBe(true);
    const status = initialStatus();
    expect(StatusSchema.safeParse(status).success).toBe(true);
    expect(StatusSchema.safeParse({ ...status, categories: ['buff', 'control'] }).success).toBe(
      true,
    );
    expect(StatusSchema.safeParse({ ...status, categories: ['passive'] }).success).toBe(false);
  });
  it('silences by the magic category and infers magic only from MP when categories are omitted', async () => {
    const ability = await baseAbility();
    expect([
      blockedBySilence({ ...ability, ...designs.mpSword }),
      blockedBySilence({ ...ability, ...designs.freeSpell }),
      blockedBySilence({ ...ability, ...designs.magicSword }),
      blockedBySilence({ ...ability, costs: costs(3) }),
      blockedBySilence({ ...ability, costs: costs(0) }),
    ]).toEqual([false, true, true, true, false]);
    expect(abilityCategories({ ...ability, costs: costs(3) })).toEqual(['magic']);
    expect(abilityCategories({ ...ability, costs: costs(0) })).toEqual([]);
    expect(abilityCategories({ ...ability, ...designs.magicSword, costs: costs(9) })).toEqual([
      'physical',
      'magic',
    ]);
    const debuff = { ...initialStatus(), categories: ['debuff' as const] };
    expect(dispelMatchesCategory({ kind: 'dispel', categories: ['debuff'] }, debuff)).toBe(true);
    expect(dispelMatchesCategory({ kind: 'dispel', categories: ['buff'] }, debuff)).toBe(false);
    expect(dispelMatchesCategory({ kind: 'dispel', statusIds: ['hex'] }, debuff)).toBe(false);
    expect(dispelMatchesCategory({ kind: 'dispel', categories: ['debuff'] }, initialStatus())).toBe(
      false,
    );
  });
  const fixture = () =>
    aiFixture({
      abilities: [
        { ...designs.mpSword, effects: damage('physical') },
        { ...designs.freeSpell, effects: damage('fire') },
        { ...designs.magicSword, effects: damage('fire') },
      ],
    });
  it('lets silenced AI keep an MP sword technique and records why magic candidates are excluded', async () => {
    const f = await fixture();
    try {
      const ready = new Set(f.abilities.map((a) => a.id));
      const silenced = choosePolicy({ ...f.view, silenced: true }, ready, false).cognition!;
      expect(silenced.excluded.filter((e) => e.reason === 'silenced')).toEqual([
        { abilityId: 'choice-1', reason: 'silenced' },
        { abilityId: 'choice-2', reason: 'silenced' },
      ]);
      expect(silenced.selection).toBe('ability:choice-0');
      const free = choosePolicy(f.view, ready, false).cognition!;
      expect(free.excluded.some((e) => e.reason === 'silenced')).toBe(false);
    } finally {
      f.world.free();
    }
  });
  const launchedBy = async (manifest: Parameters<typeof runBattle>[0]) =>
    new Set(
      battleEvents((await runBattle(manifest)).records)
        .filter((e) => e.actorId === 'left' && e.kind === 'launch')
        .map((e) => e.abilityId)
        .filter((id) => id?.startsWith('choice')),
    );
  it('executes only non-magic abilities under a real silence status', async () => {
    const control = await fixture();
    try {
      expect((await launchedBy(control.manifest)).size).toBeGreaterThan(1);
    } finally {
      control.world.free();
    }
    const f = await fixture();
    try {
      await withInitialStatus(
        f.manifest,
        0,
        initialStatus({
          categories: ['control'],
          modifiers: {
            attack: 0,
            defense: 0,
            speedBps: 10000,
            flight: false,
            rooted: false,
            silenced: true,
          },
        }),
      );
      expect(await launchedBy(f.manifest)).toEqual(new Set(['choice-0']));
    } finally {
      f.world.free();
    }
  });
});
