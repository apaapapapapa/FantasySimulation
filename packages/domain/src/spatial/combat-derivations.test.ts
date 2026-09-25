import { expect, it } from 'vite-plus/test';
import { composeForce, stageWindow, actionClock } from './combat-derivations.ts';
import fixture from '../../fixtures/replay/mutual-hit.json' with { type: 'json' };
import { RecordedManifestSchema } from './replay.ts';

it('caps a joint force once, preserving cancellation and the exact cap boundary', () => {
  const vector = (x: number, y = 0, z = 0) => ({ velocityMmPerSecond: { x, y, z } });
  expect(composeForce([vector(100000), vector(-100000)], 1)).toEqual({
    active: false,
    capped: false,
    force: { x: 0, y: 0, z: 0 },
  });
  expect(composeForce([vector(3000, 4000)], 5000)).toEqual({
    active: true,
    capped: false,
    force: { x: 3, y: 4, z: 0 },
  });
  expect(composeForce([vector(6000), vector(0, 8000)], 5000)).toEqual({
    active: true,
    capped: true,
    force: { x: 3, y: 4, z: 0 },
  });
  const maximum = composeForce(
    Array.from({ length: 256 }, () => vector(100000, -100000, 100000)),
    100000,
  );
  expect(maximum.capped).toBe(true);
  expect(maximum.force.x).toBeCloseTo(100 / Math.sqrt(3), 12);
  expect(maximum.force.y).toBeCloseTo(-100 / Math.sqrt(3), 12);
});

it('retains fixed stage clocks and rounds scaled cast/recovery/cooldown independently', () => {
  const revision = RecordedManifestSchema.parse(fixture.input).revisions.find(
    (r) => r.kind === 'ability',
  )!;
  if (revision.kind !== 'ability') throw new Error('Missing fixture ability');
  const ability = {
    ...revision.definition,
    castSteps: 3,
    recoverySteps: 3,
    cooldownSteps: 5,
    attack: {
      kind: 'melee' as const,
      reachMm: 1000,
      radiusMm: 100,
      activeSteps: 4,
      maxHitsPerTarget: 1,
    },
  };
  expect(stageWindow(7, { offsetSteps: 2, durationSteps: 4 })).toEqual({ startAt: 9, endAt: 13 });
  expect(actionClock(ability, 20000, 10)).toEqual({
    launchAt: 12,
    recoveryUntil: 18,
    cooldownUntil: 15,
  });
  expect(actionClock(ability, 0, 10)).toBeNull();
});
