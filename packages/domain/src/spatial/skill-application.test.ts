import { describe, expect, it } from 'vite-plus/test';
import { sampleCatalog } from '@fantasy/samples';
import type { SkillResolution } from '../skill-system.ts';
import {
  applySkillAbilityApplications,
  resolveSkillAbilityApplications,
} from './skill-application.ts';
import { revisionHash, revisionIndex, revisionReference } from './revision-graph.ts';

async function fixture() {
  const revisions = await sampleCatalog(),
    sword = revisions.find((r) => r.kind === 'ability' && r.id === 'sword'),
    parry = revisions.find((r) => r.kind === 'ability' && r.id === 'parry-v1');
  if (sword?.kind !== 'ability' || parry?.kind !== 'ability') throw new Error('Missing fixture');
  const changed = {
    ...sword,
    revision: 2,
    definition: { ...sword.definition, name: 'Test replacement' },
  };
  changed.contentHash = await revisionHash(changed);
  const another = {
    ...changed,
    revision: 3,
    definition: { ...changed.definition, name: 'Another replacement' },
  };
  another.contentHash = await revisionHash(another);
  const get = revisionIndex([...revisions, changed, another]),
    base = revisionReference(sword),
    replacement = revisionReference(changed),
    augment = { kind: 'augment' as const, baseAbility: base, resolvedAbility: replacement },
    active = { kind: 'active-ability' as const, ability: base },
    passive = { kind: 'passive-ability' as const, ability: revisionReference(parry) };
  const resolve = (owned: (typeof base)[], resolutions: SkillResolution[]) =>
    resolveSkillAbilityApplications(owned, { kind: 'new-v2-write', resolutions }, get);
  return { base, replacement, another, augment, active, passive, resolve };
}
describe('pure skill ability application', () => {
  it('applies active, passive and an exact original-base augment without mutating either input', async () => {
    const f = await fixture(),
      owned = [f.base],
      recipes = [f.augment, f.passive],
      before = structuredClone({ owned, recipes });
    expect(applySkillAbilityApplications(owned, f.resolve(owned, recipes))).toEqual([
      f.replacement,
      f.passive.ability,
    ]);
    expect({ owned, recipes }).toEqual(before);
    expect(applySkillAbilityApplications([], f.resolve([], [f.active, f.active]))).toEqual([
      f.base,
    ]);
  });
  it('never uses a skill grant or an earlier replacement as an augment base', async () => {
    const f = await fixture();
    for (const recipes of [[f.augment], [f.active, f.augment], [f.augment, f.active]])
      expect(() => f.resolve([], recipes)).toThrow(
        expect.objectContaining({ code: 'augment-base-not-owned' }),
      );
    expect(() =>
      f.resolve([{ ...f.base, contentHash: `sha256:${'0'.repeat(64)}` }], [f.augment]),
    ).toThrow(expect.objectContaining({ code: 'augment-base-not-owned' }));
    expect(() =>
      f.resolve(
        [f.base],
        [
          f.augment,
          {
            kind: 'augment',
            baseAbility: f.replacement,
            resolvedAbility: revisionReference(f.another),
          },
        ],
      ),
    ).toThrow(expect.objectContaining({ code: 'augment-base-not-owned' }));
    expect(() =>
      f.resolve(
        [f.base],
        [f.augment, { ...f.augment, resolvedAbility: revisionReference(f.another) }],
      ),
    ).toThrow(expect.objectContaining({ code: 'duplicate-augment' }));
  });
  it('rejects incompatible kinds, identities and competing grants', async () => {
    const f = await fixture();
    for (const resolvedAbility of [f.base, f.passive.ability])
      expect(() => f.resolve([f.base], [{ ...f.augment, resolvedAbility }])).toThrow(
        expect.objectContaining({
          code: resolvedAbility.id === f.base.id ? 'augment-identity' : 'augment-trigger',
        }),
      );
    expect(() => f.resolve([], [{ ...f.active, ability: f.passive.ability }])).toThrow(
      expect.objectContaining({ code: 'active-trigger' }),
    );
    expect(() => f.resolve([], [{ ...f.passive, ability: f.base }])).toThrow(
      expect.objectContaining({ code: 'passive-trigger' }),
    );
    expect(() =>
      applySkillAbilityApplications(
        [f.base],
        f.resolve([f.base], [{ ...f.active, ability: f.replacement }]),
      ),
    ).toThrow(expect.objectContaining({ code: 'conflicting-grant' }));
    expect(() => f.resolve([], [{ ...f.active, ability: { ...f.base, revision: 999 } }])).toThrow(
      expect.objectContaining({ code: 'missing-revision' }),
    );
  });
  it('fails closed for an unknown receipt version instead of guessing from the write version', async () => {
    expect(() =>
      resolveSkillAbilityApplications(
        [],
        { kind: 'recorded-receipt', receipt: { schemaVersion: 99 } as never },
        () => undefined,
      ),
    ).toThrow();
  });
});
