import type { Budget } from '@fantasy/domain/spatial/execution';
import type { NavigationResult } from '../navigation.ts';
import { SpatialBudgetError } from '../physics.ts';

/** Attempted work survives an aborted transaction; limits and statistics have one owner. */
export class WorkMeter {
  private readonly budget: Budget;
  private candidateCount = 0;
  private pathNodeCount = 0;
  private projectilePeak = 0;
  readonly reactions = { attempts: 0 };

  constructor(budget: Budget) {
    this.budget = budget;
  }
  get candidates() {
    return this.candidateCount;
  }
  get pathNodes() {
    return this.pathNodeCount;
  }
  get peakProjectiles() {
    return this.projectilePeak;
  }

  candidate() {
    if (++this.candidateCount > this.budget.maxCandidates)
      throw new SpatialBudgetError('candidates');
  }
  recordNavigation(result: NavigationResult | null | undefined) {
    this.pathNodeCount += result?.visited ?? 0;
    if (result?.kind === 'budget-exceeded') throw new SpatialBudgetError('path-nodes');
  }
  projectiles(count: number) {
    this.projectilePeak = Math.max(this.projectilePeak, count);
    if (count > this.budget.maxProjectiles) throw new SpatialBudgetError('projectiles');
  }
}
