import { beforeAll, expect, it } from 'vite-plus/test';
import { AbilitySchema, DEFAULT_BUDGET, type SpatialShape } from '@fantasy/domain/spatial';
import { objectAbility, objectManifest } from '../../test-support/object-manifest.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';
import { initializePhysics, SpatialWorld, straight } from './world/physics.ts';
import { objectsOverlap, objectGeometry, shapeFits } from './world/object-geometry.ts';
import { prepareBattle } from './prepare.ts';
import { initialActor } from './sim/combat-state.ts';
import { createBattleWorld } from './world/terrain.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { WorkMeter } from './sim/work-meter.ts';
import {
  queueSpatialObject,
  activateSpatialObjects,
  expireSpatialObjects,
} from './sim/spatial-commands.ts';
import { areaContact, beamContact } from './rules/object-contact.ts';
import { damageBarrierContact, commitBarrierDamage } from './sim/barrier-damage.ts';

beforeAll(initializePhysics);
it.each<SpatialShape>([
  { kind: 'sphere', radiusMm: 500 },
  { kind: 'box', sizeMm: { x: 200, y: 1000, z: 1000 }, yawMilliDegrees: 45000 },
  { kind: 'cylinder', radiusMm: 500, heightMm: 1000 },
])('uses solid %j placement and accepts floor support without penetration', (shape) => {
  const world = new SpatialWorld([]),
    a = objectGeometry('a', shape, { x: 0, y: 0.5, z: 0 }),
    b = { ...a, id: 'b', position: { ...a.position, y: 0.6 } };
  try {
    expect(shapeFits(a, { x: -2, y: 0, z: -2 }, { x: 2, y: 2, z: 2 })).toBe(true);
    expect(objectsOverlap(world, a, b)).toBe(true);
    expect(objectsOverlap(world, a, { ...b, position: { x: 3, y: 0.5, z: 0 } })).toBe(false);
  } finally {
    world.free();
  }
});
it('activates a fixed barrier on the next boundary and removes it at the exclusive end', async () => {
  const input = await objectManifest('barrier'),
    run = await runBattle(input);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
  const spawns = run.records.flatMap((r) =>
    r.kind === 'boundary' ? (r.objects?.spawn ?? []) : [],
  );
  expect(spawns).toHaveLength(2);
  for (const o of spawns) {
    expect(o.activeFrom).toBe(o.launchStep + 1);
    expect(o.endStep).toBe(o.activeFrom + 3);
    const removal = run.records.find(
      (r) => r.kind === 'boundary' && r.objects?.remove.some((p) => p.id === o.id),
    );
    expect(removal?.kind === 'boundary' && removal.step).toBe(o.endStep);
  }
  await recordedCheckpoints(input, run);
});
it('sweeps an area crossing and retains detached ledger occupancy between pulses', async () => {
  const input = await objectManifest('area'),
    run = await runBattle(input);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
  const events = battleEvents(run.records),
    hits = events.filter((e) => e.kind === 'hit' && e.ruleId === 'area.contact');
  expect(hits).toHaveLength(4);
  for (const id of input.participants.map((p) => p.actorId)) {
    const own = hits.filter((e) => e.actorId === id);
    expect(own[1]!.step - own[0]!.step).toBe(3);
  }
  await recordedCheckpoints(input, run);
  const battle = await prepareBattle(input),
    world = createBattleWorld(battle);
  try {
    const target = initialActor(world, battle.actors[0]).body.motion;
    const hit = areaContact(
      world,
      objectGeometry('area', { kind: 'sphere', radiusMm: 500 }, { x: 0, y: 0.9, z: 0 }),
      target,
      straight({ x: -2, y: 0.9, z: 0 }, { x: 2, y: 0.9, z: 0 }),
    );
    expect(hit?.time).toBeGreaterThan(0);
    expect(hit?.time).toBeLessThan(0.5);
    const ledger = new HitLedger(),
      stage = { actionId: 'a', stageId: 's', stageIndex: 0, emitterId: 0, hitGroupId: 'g' },
      rule = { group: 'g', maxHits: 2, minIntervalSteps: 1, requireSeparation: true };
    expect(ledger.contact(stage, rule, 'enemy', 1).accepted).toBe(true);
    ledger.occupy(stage, 'enemy', 2);
    expect(ledger.contact(stage, rule, 'enemy', 3).reason).toBe('hit-separation');
    expect(ledger.contact(stage, rule, 'enemy', 5).accepted).toBe(true);
  } finally {
    world.free();
  }
});
it('clips a moving beam at blockers and uses one shared hit ledger', async () => {
  const input = await objectManifest('beam'),
    run = await runBattle(input);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
  expect(
    battleEvents(run.records).filter((e) => e.kind === 'hit' && e.ruleId === 'beam.contact'),
  ).toHaveLength(4);
  await recordedCheckpoints(input, run);
  const battle = await prepareBattle(input),
    world = createBattleWorld(battle),
    blocked = world.rebuild([
      ...world.allObstacles(),
      {
        id: 'wall',
        position: { x: 0, y: 1, z: 0 },
        halfExtents: { x: 0.01, y: 1, z: 1 },
        blocks: { movement: true, vision: true, attack: true },
      },
    ]);
  try {
    const target = initialActor(world, battle.actors[1]).body.motion;
    const result = beamContact(
      blocked,
      straight({ x: -2, y: 0.9, z: -0.2 }, { x: -2, y: 0.9, z: 0.2 }),
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      8,
      0.03,
      target,
      straight(target.position, target.position),
      64,
    );
    expect(result.contact).toBeNull();
    expect(result.walls.length).toBeGreaterThan(0);
    expect(
      result.geometry.kind === 'ray' && result.geometry.segments.every((s) => s.end.x < 0),
    ).toBe(true);
  } finally {
    blocked.free();
    world.free();
  }
});
it('sums two barrier damage requests without changing interval geometry and rolls back cap plus one', async () => {
  const battle = await prepareBattle(await objectManifest('barrier')),
    world = createBattleWorld(battle),
    actors = battle.actors.map((a) => initialActor(world, a));
  const ability = actors[0]!.body.motion.actor.abilities[0]!;
  actors[0]!.actions.action = {
    id: 'paid',
    ability,
    cause: 'e.0',
    startedAt: 0,
    launchAt: 0,
    recoveryUntil: 3,
    released: true,
  };
  const context = {
    battle,
    world,
    budget: { ...DEFAULT_BUDGET, maxSpatialObjects: 1 },
    navigators: new Map(),
    work: new WorkMeter(DEFAULT_BUDGET),
  };
  const state = { actors, melees: [], projectiles: [], serial: 0, ledger: new HitLedger() };
  const tx = new StepTransaction(context, state, 0, 1, 0, 'interval');
  try {
    queueSpatialObject(tx, tx.next.actors[0]!, ability, 'e.0');
    expect(() => queueSpatialObject(tx, tx.next.actors[0]!, ability, 'e.0')).toThrow(
      'spatial-objects',
    );
    expect(state.serial).toBe(0);
    expect(state).not.toHaveProperty('objects');
    tx.next.objects!.pop();
    const boundary = new StepTransaction(context, tx.next, 1, 1, 0, 'boundary');
    try {
      activateSpatialObjects(boundary);
      const object = boundary.next.objects![0]!;
      expect(object.active).toBe(true);
      const offensive = {
        ...ability,
        definition: {
          ...ability.definition,
          effects: [
            { kind: 'damage' as const, amount: 6, attackScaleBps: 0, element: 'physical' as const },
          ],
        },
      };
      const source = { ownerId: object.ownerId, ability: offensive, cause: 'e.0', attack: 0 };
      const contact = {
        kind: 'wall' as const,
        time: 0,
        point: object.position,
        center: object.position,
        obstacleIds: [object.id],
      };
      damageBarrierContact(boundary, source, contact, 0);
      damageBarrierContact(boundary, source, contact, 0);
      expect(object.kind === 'barrier' && object.durability).toBe(10);
      commitBarrierDamage(boundary);
      expect(object.kind === 'barrier' && object.durability).toBe(0);
      expect(boundary.context.world.obstacles('attack').some((o) => o.id === object.id)).toBe(true);
      expireSpatialObjects(boundary);
      expect(boundary.next.objects).toEqual([]);
    } finally {
      boundary.discardWorld();
    }
  } finally {
    tx.discardWorld();
    world.free();
  }
});
it('rejects unsupported object triggers, missing authored windows and impossible arm times', () => {
  expect(
    AbilitySchema.safeParse({ ...objectAbility('barrier'), trigger: 'battle-start' }).success,
  ).toBe(false);
  const beam = objectAbility('beam');
  delete beam.stages;
  expect(AbilitySchema.safeParse(beam).success).toBe(false);
  const area = objectAbility('area');
  if (area.attack?.kind !== 'area') throw new Error('Fixture');
  area.attack.armDelaySteps = area.attack.durationSteps;
  expect(AbilitySchema.safeParse(area).success).toBe(false);
});
