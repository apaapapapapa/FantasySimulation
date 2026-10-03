import type { SkillResolution } from '../skill-system.ts';
import {
  SkillLoadoutReceiptSchema,
  skillReceiptExecutionResolutions,
  type SkillLoadoutReceipt,
  type Revision,
  type RevisionRef,
} from './contracts.ts';
import {
  requireRevision,
  revisionReference,
  revisionRefKey,
  type RevisionLookup,
} from './revision-graph.ts';
import { resolveSkillRecipe } from './skill-recipe.ts';

type Ability = Extract<Revision, { kind: 'ability' }>;
export type SkillApplicationSource =
  | { kind: 'recorded-receipt'; receipt: SkillLoadoutReceipt | undefined }
  | { kind: 'new-v2-write'; resolutions: readonly SkillResolution[] };
export class SkillApplicationError extends Error {
  readonly code: 'augment-base-not-owned' | 'duplicate-augment' | 'conflicting-grant';
  readonly abilityId: string;
  constructor(code: SkillApplicationError['code'], abilityId: string, message: string) {
    super(message);
    this.name = 'SkillApplicationError';
    this.code = code;
    this.abilityId = abilityId;
  }
}

/** Exact recipe application only. The base is always the original character/equipment set.
 * Receipt V1 intentionally retains its historical active-trigger acceptance. New V2 writes
 * use strict recipes even when their resulting battle receipt will be V1.
 * Input definition/loadout validity and final execution/display limits remain with the caller.
 */
export function resolveSkillAbilityApplications(
  base: readonly RevisionRef[],
  source: SkillApplicationSource,
  lookup: RevisionLookup,
) {
  const receipt =
      source.kind === 'recorded-receipt' && source.receipt
        ? SkillLoadoutReceiptSchema.parse(source.receipt)
        : undefined,
    resolutions =
      source.kind === 'new-v2-write'
        ? source.resolutions
        : receipt
          ? skillReceiptExecutionResolutions(receipt)
          : [],
    original = new Map(base.map((ref) => [ref.id, ref])),
    grants: Ability[] = [],
    augmentations: Array<{ base: Ability; resolved: Ability }> = [],
    augmented = new Set<string>();
  for (const item of resolutions) {
    if (item.kind === 'augment') {
      const baseAbility = requireRevision(lookup, 'ability', item.baseAbility),
        resolved = requireRevision(lookup, 'ability', item.resolvedAbility),
        owned = original.get(baseAbility.id);
      if (!owned || revisionRefKey(owned) !== revisionRefKey(item.baseAbility))
        throw new SkillApplicationError(
          'augment-base-not-owned',
          baseAbility.id,
          `Augment base ability is not in the character loadout: ${baseAbility.id}`,
        );
      resolveSkillRecipe(item, lookup);
      if (augmented.has(baseAbility.id))
        throw new SkillApplicationError(
          'duplicate-augment',
          baseAbility.id,
          `Duplicate augment base: ${baseAbility.id}`,
        );
      augmented.add(baseAbility.id);
      augmentations.push({ base: baseAbility, resolved });
    } else {
      const resolved =
        receipt?.schemaVersion === 1
          ? { ability: requireRevision(lookup, 'ability', item.ability) }
          : resolveSkillRecipe(item, lookup);
      if (!('ability' in resolved)) throw new Error('Expected skill grant');
      grants.push(resolved.ability);
    }
  }
  return { grants, augmentations };
}

/** Shared exact grants run once; augmentations replace only after every original-base check. */
export function applySkillAbilityApplications(
  base: readonly RevisionRef[],
  applications: ReturnType<typeof resolveSkillAbilityApplications>,
): RevisionRef[] {
  const byId = new Map(base.map((ref) => [ref.id, ref]));
  for (const grant of applications.grants) {
    const previous = byId.get(grant.id);
    if (previous && revisionRefKey(previous) !== revisionRefKey(grant))
      throw new SkillApplicationError(
        'conflicting-grant',
        grant.id,
        `Skill ability conflicts with equipped ability: ${grant.id}`,
      );
    byId.set(grant.id, revisionReference(grant));
  }
  for (const { resolved } of applications.augmentations)
    byId.set(resolved.id, revisionReference(resolved));
  return [...byId.values()];
}
