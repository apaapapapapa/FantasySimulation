import type { BattleEvent, Budget } from '@fantasy/domain/spatial/execution';
import type { PreparedBattle } from '../state.ts';
import type { Journal } from '../rules/journal.ts';
import type { SpatialWorld } from '../world/physics.ts';
import type { DependentState } from '../state.ts';

export type EffectContext = {
  statusSteps?: Map<string, number>;
  capture?: (
    effects: import('../state.ts').PendingEffect[],
  ) => import('../state.ts').PendingEffect[];
  beforeCommit?: (
    effects: import('../state.ts').PendingEffect[],
  ) => import('../state.ts').PendingEffect[];
  interferencePoint?: 'startup' | 'boundary' | 'status-commit';
  aliveAtStart?: ReadonlySet<string>;
  battle: PreparedBattle;
  journal: Journal;
  step: number;
  activationStep: number;
  phase: BattleEvent['phase'];
  budget: Budget;
  world: SpatialWorld;
  dependents?: DependentState[];
};
