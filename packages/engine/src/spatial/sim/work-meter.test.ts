import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { SpatialBudgetError } from '../world/physics.ts';
import { WorkMeter } from './work-meter.ts';

describe('work retained across aborted step transactions', () => {
  it('counts the candidate that exceeds the limit as attempted work', () => {
    const work = new WorkMeter({ ...DEFAULT_BUDGET, maxCandidates: 1 });
    work.candidate();
    expect(() => work.candidate()).toThrow(SpatialBudgetError);
    expect(work.candidates).toBe(2);
  });
  it('accumulates visited nodes while preserving the per-search budget outcome', () => {
    const work = new WorkMeter({ ...DEFAULT_BUDGET, maxPathNodes: 12 });
    work.recordNavigation({ kind: 'path', waypoints: [], visited: 10 });
    work.recordNavigation({ kind: 'unreachable', visited: 11 });
    work.recordNavigation(null);
    expect(work.pathNodes).toBe(21);
    expect(() => work.recordNavigation({ kind: 'budget-exceeded', visited: 12 })).toThrow(
      'path-nodes',
    );
    expect(work.pathNodes).toBe(33);
  });
  it('retains the projectile high-water mark including a rejected spawn', () => {
    const work = new WorkMeter({ ...DEFAULT_BUDGET, maxProjectiles: 2 });
    work.projectiles(2);
    work.projectiles(1);
    expect(work.peakProjectiles).toBe(2);
    expect(() => work.projectiles(3)).toThrow('projectiles');
    expect(work.peakProjectiles).toBe(3);
  });
});
