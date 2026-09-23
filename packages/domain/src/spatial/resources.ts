import type { DeepReadonly } from './canonical.ts';
import type { Definition } from './contracts.ts';
import type { ResourceState } from './records.ts';

export type ResourceLimits = { hp: number; mp: number; stamina?: number };
export function resourceLimits(character: DeepReadonly<Definition<'character'>>): ResourceLimits {
  return {
    hp: character.stats.hp,
    mp: character.stats.mp,
    ...(character.stamina ? { stamina: character.stamina.max } : {}),
  };
}
/** Shared by live initialization and independent replay validation; never adds legacy fields. */
export function initialResources(character: DeepReadonly<Definition<'character'>>): ResourceState {
  return { ...resourceLimits(character), shield: character.stats.shield };
}
