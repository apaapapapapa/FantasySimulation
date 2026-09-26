import type { BattleEvent, Budget } from '@fantasy/domain/spatial/execution';
import type { PreparedBattle } from '../state.ts';
import type { Journal } from '../rules/journal.ts';
import type { SpatialWorld } from '../world/physics.ts';

export type EffectContext = {
  interferencePoint?: 'startup' | 'boundary' | 'status-commit';
  aliveAtStart?: ReadonlySet<string>;
  battle: PreparedBattle;
  journal: Journal;
  step: number;
  activationStep: number;
  phase: BattleEvent['phase'];
  budget: Budget;
  world: SpatialWorld;
};
