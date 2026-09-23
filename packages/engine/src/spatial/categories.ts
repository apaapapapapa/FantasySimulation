import type {
  AbilityCategory,
  DeepReadonly,
  Definition,
  Effect,
  StatusCategory,
} from '@fantasy/domain/spatial';

type Ability = DeepReadonly<Definition<'ability'>>;
type Status = DeepReadonly<Definition<'status'>>;

const NONE: readonly never[] = Object.freeze([]);
const LEGACY_MAGIC: readonly AbilityCategory[] = Object.freeze(['magic']);

/**
 * Issue #61 G-01: the one place that interprets ability categories.
 * Omitted categories keep the pre-category silence meaning: an MP cost implies `magic`.
 */
export function abilityCategories(ability: Ability): readonly AbilityCategory[] {
  return ability.categories ?? (ability.costs.mp > 0 ? LEGACY_MAGIC : NONE);
}
export const hasAbilityCategory = (ability: Ability, category: AbilityCategory) =>
  abilityCategories(ability).includes(category);
/** Silence blocks every ability with the `magic` category, including physical+magic hybrids. */
export const blockedBySilence = (ability: Ability) => hasAbilityCategory(ability, 'magic');

export const statusCategories = (status: Status): readonly StatusCategory[] =>
  status.categories ?? NONE;
/** A dispel selects a status by listed ID or by any shared category. */
export function dispelSelects(
  effect: DeepReadonly<Extract<Effect, { kind: 'dispel' }>>,
  status: { id: string; definition: Status },
): boolean {
  if (effect.statusIds?.includes(status.id)) return true;
  const wanted = effect.categories;
  return !!wanted && statusCategories(status.definition).some((c) => wanted.includes(c));
}
