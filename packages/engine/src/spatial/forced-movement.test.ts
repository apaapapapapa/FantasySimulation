import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { initializePhysics, SpatialWorld, type MotionProjection } from './physics.ts';
import { moveActors, projectForcedMotion } from './movement.ts';
import { ZERO } from './math.ts';
import { locomotionFixture } from '../../test-support/locomotion.ts';
import { boxObstacle } from '../../test-support/fixtures.ts';

beforeAll(initializePhysics);
describe('shared forced-motion projections', () => {
  it('projects both components from their combined incidence and preserves unblocked cancellation', () => {
    for (const [g, f, normal] of [
      [4, 12, -1],
      [4, -12, 1],
      [-4, 12, -1],
    ] as const) {
      const result = projectForcedMotion(
        { x: 0, y: g, z: 0 },
        { x: 0, y: f, z: 0 },
        [{ fraction: 1, kind: 'wall', normal: { x: 0, y: normal, z: 0 } }],
        0.7,
      );
      expect(result.gravity).toEqual(ZERO);
      expect(result.force).toEqual(ZERO);
      expect(result.incident.y).toBe(g + f);
    }
    const cancelled = projectForcedMotion({ x: 0, y: 4, z: 0 }, { x: 0, y: -4, z: 0 }, [], 0.7);
    expect(cancelled.gravity.y).toBe(4);
    expect(cancelled.force.y).toBe(-4);
  });
  it('reports a wall at the exact trace endpoint without changing the legacy path', () => {
    const world = new SpatialWorld([
      {
        id: 'ceiling',
        position: { x: 0, y: 2, z: 0 },
        halfExtents: { x: 10, y: 1, z: 10 },
        blocks: { movement: true, vision: true, attack: true },
      },
    ]);
    try {
      const projections: MotionProjection[] = [],
        start = { ...ZERO },
        delta = { x: 0, y: 0.798, z: 0 },
        body = { radius: 0.1, halfHeight: 0.1 };
      const legacy = world.trace(start, delta, body);
      const traced = world.trace(start, delta, body, 8, 0.7, projections);
      expect(traced).toEqual(legacy);
      expect(projections).toEqual([
        { fraction: 1, kind: 'wall', normal: { x: 0, y: -1, z: 0 }, obstacleId: 'ceiling' },
      ]);
    } finally {
      world.free();
    }
  });
  it('uses shared collision geometry while bypassing voluntary speed, jump and step requests', async () => {
    const f = await locomotionFixture();
    try {
      const moved = moveActors(
        f.world,
        [f.actor.body.motion],
        new Map([
          [
            'left',
            {
              ...f.actor.body.intent,
              canMove: false,
              jump: true,
              forced: { gravity: { ...ZERO }, force: { x: 80, y: 0, z: 0 } },
            },
          ],
        ]),
        f.battle.rules,
      )[0]!;
      expect(moved.state.position.x).toBeCloseTo(-2.4, 8);
      expect(moved.jumped).toBe(false);
      expect(moved.stepped).toBe(false);
      expect(moved.forced!.gravity).toEqual(ZERO);
      expect(moved.state.velocity.x).toBe(80);
    } finally {
      f.world.free();
    }
  });
  it('clears upward force and gravity at a ceiling, so normal movement falls from zero velocity', async () => {
    const f = await locomotionFixture([
      boxObstacle('ceiling', { x: -4000, y: 2000, z: 0 }, { x: 1000, y: 100, z: 1000 }),
    ]);
    try {
      const rules = { ...f.battle.rules, gravityMmPerSecond2: -10000 };
      const launch = moveActors(
        f.world,
        [f.actor.body.motion],
        new Map([
          [
            'left',
            {
              ...f.actor.body.intent,
              canMove: false,
              forced: { gravity: { x: 0, y: 4, z: 0 }, force: { x: 0, y: 12, z: 0 } },
            },
          ],
        ]),
        rules,
      )[0]!;
      expect(launch.forced!.gravity).toEqual(ZERO);
      expect(launch.forced!.force).toEqual(ZERO);
      expect(launch.forced!.incident.y).toBeCloseTo(15.8, 8);
      expect(launch.state.velocity.y).toBe(0);
      const fall = moveActors(
        f.world,
        [launch.state],
        new Map([['left', { ...f.actor.body.intent, canMove: false }]]),
        rules,
      )[0]!;
      expect(fall.state.velocity.y).toBeCloseTo(-0.2, 8);
      expect(fall.state.position.y).toBeLessThan(launch.state.position.y);
    } finally {
      f.world.free();
    }
  });
  it('stops both components at body contact and discards wall projections after that stop', async () => {
    const f = await locomotionFixture([
      boxObstacle('later-wall', { x: -2000, y: 1000, z: 0 }, { x: 100, y: 1000, z: 1000 }),
    ]);
    try {
      const target = {
        ...f.actor.body.motion,
        actor: f.battle.actors[1],
        position: { ...f.actor.body.motion.position, x: -3 },
      };
      const moved = moveActors(
        f.world,
        [f.actor.body.motion, target],
        new Map([
          [
            'left',
            {
              ...f.actor.body.intent,
              forced: { gravity: { ...ZERO }, force: { x: 100, y: 0, z: 0 } },
            },
          ],
          ['right', { ...f.actor.body.intent, canMove: false }],
        ]),
        f.battle.rules,
      );
      expect(moved[0]!.contactTime).toBeLessThan(0.3);
      expect(moved[0]!.forced!.gravity).toEqual(ZERO);
      expect(moved[0]!.forced!.force).toEqual(ZERO);
      expect(moved[0]!.forced!.projections.at(-1)!.kind).toBe('body');
      expect(moved[0]!.forced!.projections.some((p) => p.obstacleId === 'later-wall')).toBe(false);
      expect(moved[1]!.state.velocity).toEqual(ZERO);
    } finally {
      f.world.free();
    }
  });
  it('uses combined incident speed for landing damage and suppresses only gravity during flight', async () => {
    const f = await locomotionFixture();
    try {
      const start = {
        ...f.actor.body.motion,
        position: { ...f.actor.body.motion.position, y: 1.2 },
        grounded: false,
      };
      const landed = moveActors(
        f.world,
        [start],
        new Map([
          [
            'left',
            {
              ...f.actor.body.intent,
              forced: { gravity: { x: 0, y: -20, z: 0 }, force: { x: 0, y: -20, z: 0 } },
            },
          ],
        ]),
        { ...f.battle.rules, gravityMmPerSecond2: -10000 },
      )[0]!;
      expect(landed.landed).toBe(true);
      expect(landed.fallDamage).toBe(161);
      expect(landed.forced!.landingVelocityY).toBe(-40.2);
      const flight = moveActors(
        f.world,
        [start],
        new Map([
          [
            'left',
            {
              ...f.actor.body.intent,
              flight: true,
              forced: { gravity: { x: 0, y: -20, z: 0 }, force: { x: 80, y: 0, z: 0 } },
            },
          ],
        ]),
        f.battle.rules,
      )[0]!;
      expect(flight.state.position.y).toBe(1.2);
      expect(flight.forced!.gravity).toEqual(ZERO);
      expect(flight.forced!.force.x).toBe(80);
    } finally {
      f.world.free();
    }
  });
});
