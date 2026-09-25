import type { Obstacle } from './geometry-types.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_BUDGET,
  StreamRecordSchema,
  type Definition,
  type Manifest,
} from '@fantasy/domain/spatial';
import { projectileCurve, explosionCoverage, type ProjectileState } from './projectiles.ts';
import { at, initializePhysics, SpatialWorld, straight } from './physics.ts';
import { traceAttack } from './attacks.ts';
import { emptyMemory, perceive } from './perception.ts';
import { initialMotion } from './movement.ts';
import { cosDegrees, dot, unit } from './math.ts';
import { prepareBattle, reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import {
  battleEvents as events,
  combatManifest,
  editScenario,
  glassWall,
} from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';
beforeAll(initializePhysics);
const shot: Extract<Definition<'ability'>['attack'], { kind: 'projectile' }> = {
  kind: 'projectile',
  speedMmPerSecond: 1000000,
  radiusMm: 100,
  lifetimeSteps: 100,
  gravityScaleBps: 0,
  homingTurnMilliDegreesPerSecond: 0,
  observation: 'launch-only',
  explosionRadiusMm: 0,
  maxHitsPerTarget: 1,
};
async function fixture(shape = shot, maxSteps = 50, wall = false): Promise<Manifest> {
  const manifest = await combatManifest(maxSteps, {
    ability: {
      attack: shape,
      castSteps: 0,
      recoverySteps: 1,
      rangeMm: 20000,
      costs: { hp: 0, mp: 1, uses: 1 },
      effects: [{ kind: 'damage', amount: 205, attackScaleBps: 0, element: 'physical' }],
    },
    policy: { movement: 'hold' },
  });
  if (wall) await editScenario(manifest, (scenario) => scenario.obstacles.push(glassWall(1)));
  return manifest;
}
async function projectile(shape = shot) {
  const battle = await prepareBattle(await fixture(shape));
  const value: ProjectileState = {
    id: 'projectile.test',
    ownerId: 'left',
    ability: battle.actors[0].abilities[0]!,
    cause: 'e.0',
    launchStep: 0,
    position: { x: -10, y: 1, z: 0 },
    velocity: { x: shape.speedMmPerSecond / 1000, y: 0, z: 0 },
    attack: 20,
    target: { x: 0, y: 1, z: 100 },
  };
  return { battle, value };
}
describe('projectiles, curved sweeps and explosions', () => {
  it('hits once per projectile at high speed and records spawn, clipped path, impact and removal', async () => {
    const input = await fixture(),
      run = await runBattle(input);
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
    expect(run.result.steps).toBe(6);
    expect(run.result).toMatchObject({
      eventHash: 'sha256:ec4003f7cc18a2c85f827acaaca421b71b2e2e6be08e5dc775167e02a75abe74',
      trajectoryHash: 'sha256:ca3d805e79f7e5614123f61c2c2467d27b90fb3ba571193340ff7916d23af738',
      tsStateHash: 'sha256:72f1812258099bb662be92b828f05e007f0bcd20ed204799ecc0a8cd88cda811',
      physicsStateHash: 'sha256:680dac7ee74bc7a5cbdfee30427f3b7ec229ebfa68febdf361bc4ab90d551976',
    });
    expect(run.result.stats.peakProjectiles).toBe(2);
    const log = events(run.records);
    for (const kind of ['projectile-spawn', 'projectile-remove', 'hit', 'damage'])
      expect(log.filter((e) => e.kind === kind)).toHaveLength(2);
    const frame = run.records.find((r) => r.kind === 'interval' && r.fromStep === 5)!;
    if (frame.kind !== 'interval') throw new Error('Missing release interval');
    expect(frame.projectiles.spawn).toHaveLength(2);
    expect(frame.projectiles.remove).toHaveLength(2);
    const path = frame.paths.find((p) => p.entityId.startsWith('projectile.'))!;
    expect(path.segments.at(-1)!.to).toBeGreaterThan(0);
    expect(path.segments.at(-1)!.to).toBeLessThan(1);
    for (const r of run.records) expect(StreamRecordSchema.safeParse(r).success).toBe(true);
    expect((await runBattle(input)).result).toEqual(run.result);
    input.participants.reverse();
    input.revisions.reverse();
    const reversed = await runBattle(input);
    expect(reversed.result.eventHash).toBe(run.result.eventHash);
    expect(reversed.result.trajectoryHash).toBe(run.result.trajectoryHash);
  });
  it('stops both fast shots at a 2mm transparent wall without applying body damage', async () => {
    const run = await runBattle(await fixture(shot, 20, true));
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    expect(events(run.records).filter((e) => e.kind === 'damage')).toHaveLength(0);
    expect(
      events(run.records)
        .filter((e) => e.kind === 'projectile-remove')
        .map((e) => e.reason),
    ).toEqual(['wall', 'wall']);
  });
  it('sweeps against the target motion through the interval rather than its final position', async () => {
    const { battle, value } = await projectile();
    const world = new SpatialWorld([]);
    try {
      const target = initialMotion(world, battle.actors[1]);
      const curve = projectileCurve(value, emptyMemory(), battle.rules, DEFAULT_BUDGET);
      const contact = traceAttack(
        world,
        curve.trace,
        0.1,
        target,
        straight({ x: 0, y: 1, z: -5 }, { x: 0, y: 1, z: 5 }),
      );
      expect(contact?.kind).toBe('body');
      expect(contact!.time).toBeGreaterThan(0.45);
      expect(contact!.time).toBeLessThan(0.5);
    } finally {
      world.free();
    }
  });
  it('bounds parabolic chord error, enforces subdivision budgets, and preserves the path with a larger budget', async () => {
    const { battle, value } = await projectile({ ...shot, gravityScaleBps: 30000 });
    const rules = { ...battle.rules, gravityMmPerSecond2: -30000 };
    const curve = projectileCurve(value, emptyMemory(), rules, DEFAULT_BUDGET);
    expect(curve.trace).toHaveLength(3);
    for (const piece of curve.trace) {
      const t = (piece.from + piece.to) / 2;
      const exact = value.position.y - 45 * (0.02 * t) ** 2;
      expect(Math.abs(at(curve.trace, t).y - exact)).toBeLessThanOrEqual(0.001);
    }
    expect(() =>
      projectileCurve(value, emptyMemory(), rules, { ...DEFAULT_BUDGET, maxCurveSegments: 2 }),
    ).toThrow('curve-segments');
    expect(
      projectileCurve(value, emptyMemory(), rules, { ...DEFAULT_BUDGET, maxCurveSegments: 128 }),
    ).toEqual(curve);
    expect(value.position.y).toBe(1);
  });
  it('limits homing turn and only uses delivered owner observations; lost visibility continues ballistically', async () => {
    const { battle, value } = await projectile({
      ...shot,
      speedMmPerSecond: 10000,
      homingTurnMilliDegreesPerSecond: 720000,
      observation: 'owner-visible',
    });
    const sample = {
      sampledAt: 0,
      availableAt: 5,
      enemy: {
        id: 'right',
        position: { x: -10, y: 1, z: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        facing: { x: -1, y: 0, z: 0 },
        step: 0,
      },
      projectiles: [],
    };
    const hidden = projectileCurve(
      value,
      { ...emptyMemory(), pending: [sample] },
      battle.rules,
      DEFAULT_BUDGET,
    );
    expect(hidden.next.velocity.z).toBe(0);
    const visible = projectileCurve(
      value,
      { ...emptyMemory(), observation: sample },
      battle.rules,
      DEFAULT_BUDGET,
    );
    expect(visible.next.velocity.z).toBeGreaterThan(0);
    expect(dot(unit(value.velocity), unit(visible.next.velocity))).toBeGreaterThanOrEqual(
      cosDegrees(14.4) - 0.0001,
    );
    const lost = projectileCurve(
      value,
      { ...emptyMemory(), observation: { ...sample, enemy: null } },
      battle.rules,
      DEFAULT_BUDGET,
    );
    expect(lost.next.velocity.z).toBe(0);
    const frozen = await projectile({
      ...shot,
      speedMmPerSecond: 10000,
      homingTurnMilliDegreesPerSecond: 720000,
    });
    expect(
      projectileCurve(
        frozen.value,
        { ...emptyMemory(), observation: sample },
        frozen.battle.rules,
        DEFAULT_BUDGET,
      ),
    ).toEqual(projectileCurve(frozen.value, emptyMemory(), frozen.battle.rules, DEFAULT_BUDGET));
  });
  it('applies spherical body intersection, partial wall coverage and distance attenuation', async () => {
    const { battle } = await projectile();
    const wall: Obstacle = {
      id: 'wall',
      position: { x: 0, y: 1, z: 0 },
      halfExtents: { x: 0.01, y: 2, z: 2 },
      blocks: { movement: true, vision: false, attack: true },
    };
    const open = new SpatialWorld([]),
      closed = new SpatialWorld([wall]),
      partial = new SpatialWorld([
        { ...wall, position: { x: 0, y: 0.3, z: 0 }, halfExtents: { x: 0.01, y: 0.3, z: 2 } },
      ]);
    try {
      const target = initialMotion(open, battle.actors[1]),
        origin = { x: -1, y: 1, z: 0 },
        position = { x: 1, y: 1, z: 0 };
      const full = explosionCoverage(open, origin, 5, target, position),
        cover = explosionCoverage(partial, origin, 5, target, position);
      expect(full).toBeGreaterThan(0);
      expect(full).toBeLessThan(10000);
      expect(explosionCoverage(closed, origin, 5, target, position)).toBe(0);
      expect(cover).toBeGreaterThan(0);
      expect(cover).toBeLessThan(full);
      expect(explosionCoverage(open, origin, 5, target, { ...position, x: 20 })).toBe(0);
      expect(explosionCoverage(open, origin, 1.8, target, position)).toBeGreaterThan(0); // Centre outside radius, capsule surface inside.
    } finally {
      open.free();
      closed.free();
      partial.free();
    }
  });
  it('uses one explosion application per target rather than adding an extra direct-hit packet', async () => {
    const run = await runBattle(await fixture({ ...shot, explosionRadiusMm: 2000 }));
    const hits = events(run.records).filter((e) => e.ruleId === 'explosion.coverage');
    expect(hits).toHaveLength(2);
    expect(events(run.records).filter((e) => e.kind === 'damage')).toHaveLength(2);
    expect(hits.every((e) => e.amount! > 0 && e.amount! < 10000)).toBe(true);
  });
  it('expires only after its last interval and truncates simultaneous spawns atomically when the pool is full', async () => {
    const expiring = await runBattle(
      await fixture({ ...shot, speedMmPerSecond: 1000, lifetimeSteps: 1 }, 10),
    );
    expect(
      events(expiring.records)
        .filter((e) => e.ruleId === 'projectile.expired')
        .every((e) => e.step === 5 && e.subtimeMicros === 1000000),
    ).toBe(true);
    expect(events(expiring.records).filter((e) => e.ruleId === 'projectile.expired')).toHaveLength(
      2,
    );
    const input = await fixture();
    const small = await runBattle(input, { ...DEFAULT_BUDGET, maxProjectiles: 1 });
    expect(small.result).toMatchObject({
      steps: 5,
      outcome: { kind: 'truncated', resource: 'projectiles' },
    });
    expect(
      events(small.records).filter((e) => e.kind === 'cost' || e.kind === 'projectile-spawn'),
    ).toHaveLength(0);
    expect(
      (await runBattle(input, { ...DEFAULT_BUDGET, maxProjectiles: 2 })).result.simulationHash,
    ).toBe(small.result.simulationHash);
  });
  it('ends at interval defeat without waiting for a surviving enemy projectile to arrive', async () => {
    const input = await fixture();
    const fast = input.revisions.find((r) => r.kind === 'ability')!;
    const slow = await sealRevision('ability', fast.id, 2, {
      ...fast.definition,
      attack: { ...shot, speedMmPerSecond: 10000 },
    });
    const old = input.revisions.find((r) => r.kind === 'character')!;
    const right = await sealRevision('character', 'slow-archer', 1, {
      ...old.definition,
      abilities: [reference(slow)],
    });
    input.revisions.push(slow, right);
    input.participants[1].character = reference(right);
    const run = await runBattle(input);
    expect(run.result).toMatchObject({ steps: 6, outcome: { kind: 'win', winner: 'left' } });
    const frame = run.records.find((r) => r.kind === 'interval' && r.fromStep === 5)!;
    if (frame.kind !== 'interval') throw new Error('Missing final interval');
    expect(frame.projectiles.update).toHaveLength(1);
    expect(frame.projectiles.remove).toHaveLength(1);
  });
  it('does not leak private projectile state through a structural observation input', async () => {
    const { battle, value } = await projectile();
    const world = new SpatialWorld([]);
    try {
      const self = initialMotion(world, battle.actors[1]),
        enemy = initialMotion(world, battle.actors[0]);
      const publicPosition = { ...self.position, x: self.position.x - 2 };
      const memory = perceive(
        world,
        self,
        enemy,
        [{ ...value, position: publicPosition }],
        0,
        emptyMemory(),
      );
      expect(Object.keys(memory.pending[0]!.projectiles[0]!).sort()).toEqual([
        'id',
        'ownerId',
        'position',
        'radiusMm',
        'velocity',
      ]);
    } finally {
      world.free();
    }
  });
});
