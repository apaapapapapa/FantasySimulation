import { beforeAll, expect, it } from 'vite-plus/test';
import {
  AbilitySchema,
  DEFAULT_BUDGET,
  ReplayState,
  type Relocation,
} from '@fantasy/domain/spatial';
import { relocationManifest, spatialTransaction } from '../../test-support/spatial-objects.ts';
import { battleEvents, boxObstacle, editScenario } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { initializePhysics } from './world/physics.ts';
import { relocationDestination } from './rules/relocation.ts';
import { activateRelocations, queueRelocation } from './sim/relocation.ts';
import { runBattle } from './run.ts';
import type { PendingRelocation } from './state.ts';
import { catalogManifest } from '@fantasy/samples';

beforeAll(initializePhysics);
const spec: Relocation = {
  anchor: 'self',
  direction: 'front',
  distanceMm: 1000,
  maxDistanceMm: 5000,
};

it.each(['headroom', 'range', 'arena', 'support-touch'] as const)(
  'checks the whole destination capsule: %s',
  async (mode) => {
    const f = await spatialTransaction();
    try {
      const actor = f.tx.next.actors[0]!,
        motion = actor.body.motion;
      const destination = {
        x: -1,
        y:
          mode === 'support-touch'
            ? motion.actor.character.body.heightMm / 2000
            : motion.position.y,
        z: 0,
      };
      if (mode === 'arena') destination.x = f.battle.scenario.bounds.max.x / 1000;
      if (mode === 'headroom')
        f.tx.replaceGeometry([
          {
            id: 'low-ceiling',
            position: { x: -1, y: 1.75, z: 0 },
            halfExtents: { x: 0.1, y: 0.1, z: 1 },
            blocks: { movement: true, vision: true, attack: true },
          },
        ]);
      f.tx.next.relocations = [
        {
          ownerId: motion.actor.participant.actorId,
          actionId: actor.actions.action!.id,
          ability: actor.actions.action!.ability,
          cause: 'e.0',
          at: 1,
          destination,
          maxDistanceMm: mode === 'range' ? 100 : 200000,
        },
      ];
      activateRelocations(f.tx);
      expect(f.tx.journal.events[0]?.reason).toBe(
        mode === 'headroom' ? 'obstacle' : mode === 'support-touch' ? 'relocated' : mode,
      );
      expect(actor.actions.used[actor.actions.action!.ability.id]).toBe(1);
      expect(actor.vitals.resources.mp).toBe(f.previous.actors[0]!.vitals.resources.mp);
    } finally {
      f.tx.discardWorld();
      f.world.free();
    }
  },
);

it('freezes only delivered visible anchors, rounds once and uses the horizontal fallback without RNG', () => {
  const self = { position: { x: -0.0005, y: 1, z: 0 }, facing: { x: 0, y: 1, z: 0 } };
  expect(relocationDestination({ ...spec, direction: 'right' }, self, null)).toEqual({
    x: -0.001,
    y: 1,
    z: 1,
  });
  expect(relocationDestination({ ...spec, anchor: 'observed-enemy' }, self, null)).toBeNull();
  const enemy = { position: { x: 3, y: 2, z: 4 }, facing: { x: 0, y: 0, z: 1 } };
  const frozen = relocationDestination(
    { ...spec, anchor: 'observed-enemy', direction: 'left' },
    self,
    enemy,
  );
  enemy.position.x = 20;
  expect(frozen).toEqual({ x: 4, y: 2, z: 4 });
});

it.each(['same', 'swap', 'invalid-overlap'] as const)(
  'rejects all %s endpoint conflicts before changing either actor',
  async (mode) => {
    const f = await spatialTransaction();
    try {
      f.tx.next.relocations = f.previous.actors.map((actor, i): PendingRelocation => ({
        ownerId: actor.body.motion.actor.participant.actorId,
        actionId: actor.actions.action!.id,
        ability: actor.actions.action!.ability,
        cause: 'e.0',
        at: 1,
        maxDistanceMm: 200000,
        destination:
          mode === 'swap'
            ? { ...f.previous.actors[1 - i]!.body.motion.position }
            : {
                x: mode === 'invalid-overlap' ? 200 + i * 0.1 : 0,
                y: actor.body.motion.position.y,
                z: 0,
              },
      }));
      activateRelocations(f.tx);
      expect(f.tx.next.actors.map((a) => a.body.motion.position)).toEqual(
        f.previous.actors.map((a) => a.body.motion.position),
      );
      expect(f.tx.journal.events.map((e) => e.reason)).toEqual(
        mode === 'swap' ? ['occupied', 'occupied'] : ['endpoint-conflict', 'endpoint-conflict'],
      );
      expect(f.tx.next.actors.map((a) => a.vitals.resources.mp)).toEqual(
        f.previous.actors.map((a) => a.vitals.resources.mp),
      );
    } finally {
      f.world.free();
    }
  },
);

it('keeps velocity force clocks aim and RNG and ends dodge without refund', async () => {
  const f = await spatialTransaction();
  try {
    const actor = f.tx.next.actors[0]!,
      motion = actor.body.motion;
    motion.velocity = { x: 3, y: -7, z: 2 };
    actor.body.forceGravity = { x: 0, y: -7, z: 0 };
    actor.body.motionClock = { remainder: 7, flightRemainder: 9, dodgeUntilStep: 8 };
    const before = structuredClone({
      velocity: motion.velocity,
      facing: motion.facing,
      random: actor.mind.random,
      action: actor.actions.action,
      gravity: actor.body.forceGravity,
    });
    f.tx.next.relocations = [
      {
        ownerId: motion.actor.participant.actorId,
        actionId: actor.actions.action!.id,
        ability: actor.actions.action!.ability,
        cause: 'e.0',
        at: 1,
        destination: { ...motion.position, z: 1 },
        maxDistanceMm: 2000,
      },
    ];
    activateRelocations(f.tx);
    expect(motion.position.z).toBe(1);
    expect({
      velocity: motion.velocity,
      facing: motion.facing,
      random: actor.mind.random,
      action: actor.actions.action,
      gravity: actor.body.forceGravity,
    }).toEqual(before);
    expect(actor.body.motionClock).toEqual({ remainder: 7, flightRemainder: 9 });
    expect(f.tx.journal.events[0]?.kind).toBe('teleport');
  } finally {
    f.world.free();
  }
});

it('crosses an opaque wall path using full recorded jumps and restores both seek directions', async () => {
  const input = await relocationManifest();
  await editScenario(input, (s) => {
    s.obstacles.push(
      boxObstacle('left-wall', { x: -3000, y: 1500, z: 0 }, { x: 50, y: 1500, z: 3000 }),
      boxObstacle('right-wall', { x: 3000, y: 1500, z: 0 }, { x: 50, y: 1500, z: 3000 }),
    );
  });
  const run = await runBattle(input),
    jumps = battleEvents(run.records).filter((e) => e.teleport);
  expect(jumps.map((e) => e.teleport!.to.x).sort((a, b) => a - b)).toEqual([-4, 4]);
  const saved = await recordedCheckpoints(input, run);
  const before = saved.checkpoints.find((c) => c.lastRecord?.kind === 'interval' && c.step === 1)!;
  const after = saved.checkpoints.find((c) => c.lastRecord?.kind === 'boundary' && c.step === 1)!;
  for (const checkpoint of [after, before, after, before]) {
    const restored = new ReplayState(saved.context, checkpoint);
    expect(restored.checkpoint()).toEqual(checkpoint);
  }
  expect(before.state!.actors.map((a) => a.position.x)).toEqual([-2, 2]);
  expect(after.state!.actors.map((a) => a.position.x)).toEqual([-4, 4]);
  expect(after.state!.actors.map((a) => a.resources.mp)).toEqual(
    before.state!.actors.map((a) => a.resources.mp),
  );
  expect(
    run.records
      .filter((r) => r.kind === 'interval')
      .every((r) =>
        r.paths.every((p) => p.segments.every((s) => Math.abs(s.end.x - s.start.x) < 0.1)),
      ),
  ).toBe(true);
});

it('rolls back simultaneous pending commands at the exact cap and never activates a final-boundary command', async () => {
  const input = await relocationManifest();
  const failed = await runBattle(input, { ...DEFAULT_BUDGET, maxSpatialCommands: 1 });
  expect(failed.result.outcome).toMatchObject({
    kind: 'truncated',
    resource: 'spatial-commands',
    details: { observed: 2, limit: 1 },
  });
  expect(failed.records.filter((r) => r.kind === 'interval')).toHaveLength(0);
  const pass = await runBattle(input, { ...DEFAULT_BUDGET, maxSpatialCommands: 2 });
  expect(battleEvents(pass.records).filter((e) => e.teleport)).toHaveLength(2);
  const last = await runBattle(await relocationManifest({}, 1));
  expect(battleEvents(last.records).filter((e) => e.reason === 'battle-ended')).toHaveLength(2);
  expect(battleEvents(last.records).some((e) => e.teleport)).toBe(false);
});

it('rejects hidden release anchors and incompatible authored payloads before execution', async () => {
  const f = await spatialTransaction();
  try {
    const actor = f.tx.next.actors[0]!,
      ability = actor.actions.action!.ability;
    queueRelocation(f.tx, actor, ability, 'e.0', { ...spec, anchor: 'observed-enemy' });
    expect(f.tx.next.relocations).toBeUndefined();
    expect(f.tx.journal.events[0]?.reason).toContain('No delivered visible anchor');
    for (const change of [
      { trigger: 'battle-start' },
      { target: 'enemy' },
      { effects: [{ kind: 'heal', amount: 1 }] },
    ])
      expect(AbilitySchema.safeParse({ ...ability.definition, ...change }).success).toBe(false);
  } finally {
    f.world.free();
  }
});

it('runs new-ID teleport samples and preserves results under input enumeration', async () => {
  const input = await catalogManifest(
    'blink-retreat-mage-v1',
    'blink-flank-mage-v1',
    'flat-surveyed-v1',
    200,
  );
  const run = await runBattle(input);
  expect(battleEvents(run.records).some((e) => e.teleport)).toBe(true);
  await recordedCheckpoints(input, run);
  const reversed = await runBattle({
    ...input,
    participants: [...input.participants].reverse(),
    revisions: [...input.revisions].reverse(),
  });
  expect(reversed.records).toEqual(run.records);
  expect({ ...reversed.result, simulationHash: run.result.simulationHash }).toEqual(run.result);
});

it('rejects malformed teleport origins destinations and causes without partially applying replay', async () => {
  const input = await relocationManifest(),
    run = await runBattle(input);
  const saved = await recordedCheckpoints(input, run);
  const before = saved.checkpoints.find((c) => c.step === 1 && c.lastRecord?.kind === 'interval')!;
  const record = run.records.find(
    (r) => r.kind === 'boundary' && r.events.some((e) => e.teleport),
  )!;
  if (record.kind !== 'boundary') throw new Error('Missing jump boundary');
  for (const kind of ['origin', 'destination', 'cause'] as const) {
    const bad = structuredClone(record),
      event = bad.events.find((e) => e.teleport)!;
    if (kind === 'origin') event.teleport!.from.z += 1;
    if (kind === 'destination') event.teleport!.to.x = 100;
    if (kind === 'cause') event.parentEventId = 'e.0';
    const replay = new ReplayState(saved.context, before);
    expect(() => replay.apply(bad), kind).toThrow();
    expect(replay.checkpoint()).toEqual(before);
  }
});
