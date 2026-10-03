import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  RevisionSchema,
  SkillResolutionSchema,
  resolveSkillRecipe,
  revisionHash,
  revisionIndex,
  revisionReference,
} from '@fantasy/domain';
import { shieldSkillShard } from './shield-v1.ts';

const revisions = RevisionSchema.array().parse(
  JSON.parse(
    readFileSync(new URL('../../../../data/spatial/catalog.json', import.meta.url), 'utf8'),
  ),
);
const get = revisionIndex(revisions);
const parry = revisions.find((entry) => entry.kind === 'ability' && entry.id === 'parry-v1')!;
const sword = revisions.find((entry) => entry.kind === 'ability' && entry.id === 'sword')!;

describe('explicit skill authoring recipes', () => {
  it('requires an explicit domain recipe and keeps the historical shield dog recipe unchanged', () => {
    expect(SkillResolutionSchema.safeParse(undefined).success).toBe(false);
    expect(SkillResolutionSchema.safeParse({ ability: revisionReference(sword) }).success).toBe(
      false,
    );
    const historical = shieldSkillShard.nodes.find(({ id }) => id === 'skill.shield.dog.1')!;
    expect(historical.lifecycle).toBe('implemented');
    expect(historical.resolution).toEqual([
      { kind: 'active-ability', ability: revisionReference(parry) },
    ]);
    expect(() => resolveSkillRecipe(historical.resolution[0]!, get)).toThrow(
      expect.objectContaining({ code: 'active-trigger' }),
    );
    expect(
      resolveSkillRecipe({ kind: 'passive-ability', ability: revisionReference(parry) }, get),
    ).toEqual({
      kind: 'passive-ability',
      ability: parry,
    });
  });

  it('accepts action grants and rejects action-as-passive and inexact references separately', () => {
    const ability = revisionReference(sword);
    expect(resolveSkillRecipe({ kind: 'active-ability', ability }, get)).toEqual({
      kind: 'active-ability',
      ability: sword,
    });
    expect(() => resolveSkillRecipe({ kind: 'passive-ability', ability }, get)).toThrow(
      expect.objectContaining({ code: 'passive-trigger' }),
    );
    for (const invalid of [
      { ...ability, id: 'missing-ability' },
      { ...ability, revision: 999 },
      { ...ability, contentHash: `sha256:${'0'.repeat(64)}` },
    ])
      expect(() => resolveSkillRecipe({ kind: 'active-ability', ability: invalid }, get)).toThrow(
        expect.objectContaining({ code: 'missing-revision' }),
      );
  });

  it('requires an augment to change the exact revision while retaining ID and trigger', async () => {
    if (sword.kind !== 'ability' || parry.kind !== 'ability')
      throw new Error('Missing authored abilities');
    const replacement = {
      ...sword,
      revision: 2,
      definition: { ...sword.definition, name: 'Test-only sword revision' },
    };
    replacement.contentHash = await revisionHash(replacement);
    const recipe = {
      kind: 'augment' as const,
      baseAbility: revisionReference(sword),
      resolvedAbility: revisionReference(replacement),
    };
    const lookup = revisionIndex([...revisions, replacement]);
    expect(resolveSkillRecipe(recipe, lookup)).toEqual({
      kind: 'augment',
      base: sword,
      resolved: replacement,
    });
    for (const resolvedAbility of [revisionReference(sword), revisionReference(parry)])
      expect(() => resolveSkillRecipe({ ...recipe, resolvedAbility }, lookup)).toThrow(
        expect.objectContaining({ code: 'augment-identity' }),
      );
    const triggerChange = { ...parry, id: sword.id, revision: 3 };
    expect(() =>
      resolveSkillRecipe(
        { ...recipe, resolvedAbility: revisionReference(triggerChange) },
        revisionIndex([...revisions, triggerChange]),
      ),
    ).toThrow(expect.objectContaining({ code: 'augment-identity' }));
  });
});
