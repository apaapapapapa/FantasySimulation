import type { SkillResolution } from '../skill-system.ts';
import type { RevisionLookup } from './revision-graph.ts';
import { requireRevision } from './revision-graph.ts';

export type SkillRecipeCode =
  | 'active-trigger'
  | 'passive-trigger'
  | 'augment-identity'
  | 'augment-trigger';

export class SkillRecipeError extends Error {
  readonly code: SkillRecipeCode;
  readonly abilityId: string;
  constructor(code: SkillRecipeCode, abilityId: string, message: string) {
    super(message);
    this.name = 'SkillRecipeError';
    this.code = code;
    this.abilityId = abilityId;
  }
}

/** Exact definition/recipe compatibility, independent of character ownership and publication proof. */
export function resolveSkillRecipe(recipe: SkillResolution, lookup: RevisionLookup) {
  if (recipe.kind === 'augment') {
    const base = requireRevision(lookup, 'ability', recipe.baseAbility),
      resolved = requireRevision(lookup, 'ability', recipe.resolvedAbility);
    if (resolved.definition.trigger !== base.definition.trigger)
      throw new SkillRecipeError(
        'augment-trigger',
        base.id,
        `Augment must preserve ability trigger: ${base.id}`,
      );
    if (
      resolved.id !== base.id ||
      (resolved.revision === base.revision && resolved.contentHash === base.contentHash)
    )
      throw new SkillRecipeError(
        'augment-identity',
        base.id,
        `Augment must preserve ability identity and trigger: ${base.id}`,
      );
    return { kind: recipe.kind, base, resolved };
  }
  const ability = requireRevision(lookup, 'ability', recipe.ability);
  if (recipe.kind === 'active-ability' && ability.definition.trigger !== 'action')
    throw new SkillRecipeError(
      'active-trigger',
      ability.id,
      `Active skill ability must use the action trigger: ${ability.id}`,
    );
  if (recipe.kind === 'passive-ability' && ability.definition.trigger === 'action')
    throw new SkillRecipeError(
      'passive-trigger',
      ability.id,
      `Passive skill ability cannot use the action trigger: ${ability.id}`,
    );
  return { kind: recipe.kind, ability };
}
