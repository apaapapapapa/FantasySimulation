import type { ResolvedActor } from '../state.ts';

type Abilities = ResolvedActor['abilities'];
const revivals = new WeakMap<Abilities, readonly string[]>();

/** Prepared loadouts are deeply frozen. Never cache a mutable builder/test loadout.
 * The weak identity key includes the actual revision objects, not merely ability IDs.
 */
export function revivalAbilityIds(abilities: Abilities): readonly string[] {
  const cached = revivals.get(abilities);
  if (cached) return cached;
  const ids = abilities
    .filter((ability) => ability.definition.reaction?.response.kind === 'revive')
    .map((ability) => ability.id);
  if (Object.isFrozen(abilities)) revivals.set(abilities, Object.freeze(ids));
  return ids;
}
