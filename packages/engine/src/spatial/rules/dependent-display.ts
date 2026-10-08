import type { DependentDisplay } from '@fantasy/domain/spatial/execution';
import type { DependentState } from '../state.ts';

export const displayDependent = (dependent: DependentState): DependentDisplay => ({
  id: dependent.id,
  profile: dependent.profile,
  ownerId: dependent.ownerId,
  hostileOwnerId: dependent.hostileOwnerId,
  abilityId: dependent.ability.id,
  ordinal: dependent.ordinal,
  position: { ...dependent.position },
  body: dependent.body,
  hp: dependent.hp,
  maxHp: dependent.maxHp,
  createdAt: dependent.createdAt,
  expiresAt: dependent.expiresAt,
  nextActionAt: dependent.nextActionAt,
  nextUpkeepAt: dependent.nextUpkeepAt,
  rngState: dependent.rngState,
  ...(dependent.clock ? { clock: { ...dependent.clock } } : {}),
});
