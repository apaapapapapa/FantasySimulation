import { expect, it } from 'vite-plus/test';
import fixture from '../fixtures/spatial/summoning-rat-dan1-runtime-v1.json' with { type: 'json' };
import { DEPENDENT_LIMITS } from '../src/spatial/sim/dependents.ts';

it('binds the released rat foundation to its production recipe and vertical evidence', () => {
  expect(fixture).toMatchObject({
    status: 'release-ready',
    availableClaim: true,
    catalogNodeId: 'skill.summoning.rat.1',
    ability: {
      id: 'scout-rat-v1',
      revision: 1,
      contentHash: 'sha256:c137e74851756fbdd5d8aefcdaecd325347758ad1627c1bc7f7a21b673687927',
    },
    recipe: {
      uses: 1,
      hp: 80,
      lifetimeSteps: 30,
      upkeepMp: 1,
      upkeepEverySteps: 10,
      commandCostMp: 0,
      actionEverySteps: 5,
      damage: 8,
      drainBps: 0,
    },
    bounds: {
      maxActiveDependentsPerOwner: DEPENDENT_LIMITS.maxActivePerOwner,
      maxCreatedDependentsPerOwner: DEPENDENT_LIMITS.maxCreatedPerOwner,
      maxCreatedDependentsPerBattle: DEPENDENT_LIMITS.maxCreatedPerOwner * 2,
    },
  });
  expect(fixture.runtimeEvidence).toEqual([
    'apps/api/src/db/startup-data.test.ts',
    'apps/api/src/jobs/summoning-skill-status.test.ts',
    'apps/web/src/replay/summoning-skill-display.test.ts',
    'e2e/specs/skills.spec.ts',
  ]);
});
