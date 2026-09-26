import { beforeAll, expect, it } from 'vite-plus/test';
import {
  BodyPhasingSchema,
  PhasingSchema,
  TerrainSchema,
  DEFAULT_BUDGET,
  ReplayState,
} from '@fantasy/domain/spatial';
import { phasingManifest } from '../../test-support/phasing.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { initializePhysics, SpatialWorld, capsuleShape, ballShape } from './world/physics.ts';
import type { Obstacle } from './geometry-types.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';
import { initialActor } from './sim/combat-state.ts';
import { bodyWorld, attackWorld } from './rules/phasing.ts';
import { statusDamageSource } from './rules/status-damage.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { WorkMeter } from './sim/work-meter.ts';
import { updateBodyPhasing, executedPhaseInterval } from './sim/phasing.ts';
import { initialStatus } from '../../test-support/ai.ts';
import { sealRevision } from './manifest-builder.ts';
import { moveActors } from './world/movement.ts';

beforeAll(initializePhysics);
const stone = (): Obstacle => ({
  id: 'stone',
  material: 'stone',
  position: { x: 0, y: 1, z: 0 },
  halfExtents: { x: 0.5, y: 1, z: 1 },
  blocks: { movement: true, vision: true, attack: true },
});
it.each(['movement', 'attack'] as const)(
  'filters %s material faces while preserving support arena and unrelated layers',
  (layer) => {
    const world = new SpatialWorld([
      stone(),
      { ...stone(), id: 'far-wood', material: 'wood', position: { x: 3, y: 1, z: 0 } },
      { ...stone(), id: 'boundary.x.max', position: { x: 6, y: 1, z: 0 } },
    ]);
    const phase = { materials: ['stone' as const], floor: false, layer, minGroundY: 0.7 },
      query = world.forQuery({ phase });
    try {
      const left = { x: -2, y: 1, z: 0 },
        end = { x: 8, y: 1, z: 0 };
      expect(query.raycast(left, end, layer)?.obstacleId).toBe('far-wood');
      expect(query.sweep(left, { x: 10, y: 0, z: 0 }, ballShape(0.1), layer)?.obstacleId).toBe(
        'far-wood',
      );
      expect(query.overlaps({ x: 0, y: 1, z: 0 }, ballShape(0.3), layer)).toBe(false);
      expect(query.raycast({ x: 0, y: 4, z: 0 }, { x: 0, y: 0, z: 0 }, layer)?.obstacleId).toBe(
        'stone',
      );
      expect(
        query
          .forQuery({ phase: { ...phase, floor: true } })
          .raycast({ x: 0, y: 4, z: 0 }, { x: 0, y: 0, z: 0 }, layer),
      ).toBeUndefined();
      expect(query.raycast(left, end, 'vision')?.obstacleId).toBe('stone');
      const all = world.forQuery({
        phase: { ...phase, materials: ['stone', 'wood'], floor: true },
      });
      expect(all.raycast(left, end, layer)?.obstacleId).toBe('boundary.x.max');
      expect(world.raycast(left, end, layer)?.obstacleId).toBe('stone');
    } finally {
      world.free();
    }
  },
);
it('truncates at the retry after 50 executed embedded intervals and restores the last committed display', async () => {
  const input = await phasingManifest(),
    run = await runBattle(input);
  expect(run.result.outcome).toMatchObject({
    kind: 'truncated',
    resource: 'phase-exit-steps',
    details: { observed: 51, limit: 50 },
  });
  expect(run.result.steps).toBe(52);
  const saved = await recordedCheckpoints(input, run),
    last = saved.checkpoints.at(-1)!;
  expect(
    last.state!.actors.every((a) => a.phasing?.exitPending && a.phasing.extendedIntervals === 50),
  ).toBe(true);
  expect(last.state!.actors.map((a) => a.position.x)).toEqual([-4, 4]);
  expect(last.state!.actors.every((a) => a.statuses.every((s) => s.endStep > 52))).toBe(true);
  const active = saved.checkpoints.findIndex(
    (c) => c.lastRecord?.kind === 'boundary' && c.state!.actors.some((a) => a.phasing?.exitPending),
  );
  const replay = new ReplayState(saved.context, saved.checkpoints[active - 1]);
  const changed = structuredClone(run.records[active]!);
  if (changed.kind !== 'boundary') throw new Error('Exit boundary fixture');
  const delta = changed.changes.find((a) => a.phasing?.exitPending)!;
  delta.phasing!.extendedIntervals = 49;
  const before = replay.checkpoint();
  expect(() => replay.apply(changed)).toThrow('phasing exit starts at zero');
  expect(replay.checkpoint()).toEqual(before);
});
it('does not add an exit retry after the match has already ended', async () => {
  const input = await phasingManifest(52),
    run = await runBattle(input);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
  await recordedCheckpoints(input, run);
});
it('retains the counter across regrant and sealing and resets only at full solid clearance', async () => {
  const battle = await prepareBattle(await phasingManifest()),
    world = new SpatialWorld([stone()]);
  const phase = battle.statuses.find((s) => s.definition.phasing)!,
    contribution = {
      materials: ['stone' as const],
      floor: false,
      revision: { id: phase.id, revision: phase.revision, contentHash: phase.contentHash },
      causes: ['e.0'],
    };
  const actors = battle.actors.map((a) => initialActor(world, a));
  actors[0]!.body.motion.position = { x: 0, y: 1, z: 0 };
  actors[0]!.body.motion.phasing = {
    active: [],
    retained: [contribution],
    exitPending: true,
    extendedIntervals: 49,
  };
  actors[0]!.statuses = [
    { revision: phase, startStep: 0, endStep: 100, stacks: 1, causes: ['e.1'] },
  ];
  const context = {
      battle,
      world,
      budget: DEFAULT_BUDGET,
      work: new WorkMeter(DEFAULT_BUDGET),
      navigators: new Map(),
    },
    state = { actors, melees: [], projectiles: [], ledger: new HitLedger(), serial: 0 };
  const tx = new StepTransaction(context, state, 2, 2, 0, 'boundary');
  try {
    updateBodyPhasing(tx);
    expect(tx.next.actors[0]!.body.motion.phasing).toMatchObject({
      exitPending: true,
      extendedIntervals: 49,
    });
    executedPhaseInterval(tx);
    expect(tx.next.actors[0]!.body.motion.phasing?.extendedIntervals).toBe(50);
    const seal = await sealRevision(
      'status',
      'phase-seal',
      1,
      initialStatus({
        modifiers: {
          attack: 0,
          defense: 0,
          speedBps: 10000,
          flight: false,
          rooted: false,
          silenced: true,
        },
      }),
    );
    tx.next.actors[0]!.statuses.push({
      revision: seal,
      startStep: 0,
      endStep: 100,
      stacks: 1,
      causes: ['e.2'],
    });
    expect(() => updateBodyPhasing(tx)).toThrow('phase-exit-steps');
    tx.next.actors[0]!.body.motion.position.x = 2;
    updateBodyPhasing(tx);
    expect(tx.next.actors[0]!.body.motion.phasing).toBeNull();
    expect(state.actors[0]!.body.motion.phasing?.extendedIntervals).toBe(49);
  } finally {
    world.free();
  }
});
it('separates body phasing from attack snapshots and keeps actor collision physical', async () => {
  const battle = await prepareBattle(await phasingManifest()),
    world = new SpatialWorld([stone()]);
  const actor = initialActor(world, battle.actors[0]),
    enemy = initialActor(world, battle.actors[1]);
  const revision = battle.statuses.find((s) => s.definition.phasing)!;
  actor.body.motion.phasing = {
    active: [{ materials: ['stone'], floor: true, revision, causes: ['e.0'] }],
    retained: [],
    exitPending: false,
    extendedIntervals: 0,
  };
  const source = actor.body.motion.actor.abilities.find((a) => a.definition.trigger === 'action')!;
  const ability = {
    ...source,
    definition: {
      ...source.definition,
      attack: {
        kind: 'hitscan' as const,
        radiusMm: 0,
        phasing: { materials: ['stone' as const], floor: true },
      },
    },
  };
  try {
    expect(
      bodyWorld(world, actor.body.motion).overlaps(
        { x: 0, y: 1, z: 0 },
        capsuleShape({ radius: 0.3, halfHeight: 0.6 }),
      ),
    ).toBe(false);
    expect(
      attackWorld(world, { ownerId: 'left', ability: source }, actor.body.motion).occluded(
        { x: -2, y: 1, z: 0 },
        { x: 2, y: 1, z: 0 },
        'attack',
      ),
    ).toBe(true);
    const snapshot = statusDamageSource(actor, ability, 0);
    delete actor.body.motion.phasing;
    expect(
      attackWorld(world, { ownerId: 'left', ability, ...snapshot }).occluded(
        { x: -2, y: 1, z: 0 },
        { x: 2, y: 1, z: 0 },
        'attack',
      ),
    ).toBe(false);
    for (const a of [actor, enemy]) {
      a.body.motion.phasing = {
        active: [
          {
            materials: ['stone'],
            floor: true,
            revision: {
              id: revision.id,
              revision: revision.revision,
              contentHash: revision.contentHash,
            },
            causes: ['e.0'],
          },
        ],
        retained: [],
        exitPending: false,
        extendedIntervals: 0,
      };
      a.body.motion.velocity = { x: a === actor ? 100 : -100, y: 0, z: 0 };
    }
    const movements = moveActors(
      world,
      [actor.body.motion, enemy.body.motion],
      new Map(
        [actor, enemy].map((a) => [
          a.body.motion.actor.participant.actorId,
          {
            ...a.body.intent,
            direction: { x: a === actor ? 1 : -1, y: 0, z: 0 },
            flight: true,
            speedMmPerSecond: 100000,
          },
        ]),
      ),
      battle.rules,
    );
    expect(movements[0]!.contactTime).toBeGreaterThan(0);
    expect(movements[1]!.state.position.x - movements[0]!.state.position.x).toBeCloseTo(0.6, 5);
  } finally {
    world.free();
  }
});
it('rejects unknown materials duplicate masks implicit floor and oversized exit counters', () => {
  for (const input of [
    { materials: ['stone'], floor: undefined },
    { materials: ['stone', 'stone'], floor: true },
    { materials: ['air'], floor: true },
    { materials: [], floor: true },
  ])
    expect(PhasingSchema.safeParse(input).success).toBe(false);
  expect(TerrainSchema.safeParse({ kind: 'box', material: 'energy' }).success).toBe(false);
  expect(
    BodyPhasingSchema.safeParse({
      active: [],
      retained: [],
      exitPending: true,
      extendedIntervals: 51,
    }).success,
  ).toBe(false);
});
