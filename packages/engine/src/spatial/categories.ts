import type {
  AbilityCategory,
  DeepReadonly,
  Definition,
  Effect,
  StatusCategory,
} from '@fantasy/domain/spatial';
import type { StatusRevision } from './status.ts';

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
export const permanentStatus = (status: Status) => statusCategories(status).includes('permanent');
type Dispel = DeepReadonly<Extract<Effect, { kind: 'dispel' }>>;
/** True when a dispel's categories share at least one category with the status. */
export function dispelMatchesCategory(effect: Dispel, status: Status): boolean {
  const wanted = effect.categories;
  return !!wanted && statusCategories(status).some((c) => wanted.includes(c));
}
/**
 * Listed IDs remove every revision with that ID; a category match removes only the
 * matching revision, so another revision of the same ID in a different category stays.
 */
export function dispelTargets(
  effect: Dispel,
  active: readonly StatusRevision[],
): (string | StatusRevision)[] {
  return [
    ...(effect.statusIds ?? []),
    ...active.filter((s) => dispelMatchesCategory(effect, s.definition)),
  ];
}
