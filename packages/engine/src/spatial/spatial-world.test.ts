import { beforeAll, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { terrainBattle } from '../../test-support/fixtures.ts';
import { initialActor } from './sim/combat-state.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { WorkMeter } from './sim/work-meter.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { ballShape, initializePhysics, SpatialWorld } from './world/physics.ts';
import { createBattleWorld, terrainObstacles } from './world/terrain.ts';
import type { BlockSelector, Layer, Obstacle } from './geometry-types.ts';

beforeAll(initializePhysics);
const barrier = (selector: BlockSelector): Obstacle => ({
  id: 'barrier.fixture',
  ownerId: 'left',
  position: { x: 2, y: 2, z: 0 },
  halfExtents: { x: 0.1, y: 2, z: 2 },
  blocks: { movement: true, vision: true, attack: true },
  selectors: { movement: selector, vision: selector, attack: selector },
});

it.each([
  ['none', 'left', false],
  ['owner', 'left', true],
  ['enemy', 'left', false],
  ['both', 'left', true],
  ['owner', 'right', false],
  ['enemy', 'right', true],
] as const)(
  'applies %s for %s to every adapter without leaking view filters',
  (selector, ownerId, blocked) => {
    const world = new SpatialWorld([barrier(selector)]);
    const view = world.forQuery({ ownerId });
    const start = { x: 0, y: 2, z: 0 },
      end = { x: 4, y: 2, z: 0 };
    try {
      for (const layer of ['movement', 'vision', 'attack'] as Layer[]) {
        expect(view.obstacles(layer).length > 0).toBe(blocked);
        expect(!!view.sweep(start, end, ballShape(0.1), layer)).toBe(blocked);
        expect(view.occluded(start, end, layer)).toBe(blocked);
        expect(view.overlaps({ x: 2, y: 2, z: 0 }, ballShape(0.1), layer)).toBe(blocked);
        expect(
          view.forQuery({ ignoreObjectId: 'barrier.fixture' }).occluded(start, end, layer),
        ).toBe(false);
      }
      expect(world.casts).toBe(12);
      view.free(); // A query view never owns the shared Rapier world.
      expect(world.forQuery({ ownerId: 'left' }).obstacles('movement').length).toBe(
        selector === 'owner' || selector === 'both' ? 1 : 0,
      );
    } finally {
      world.free();
    }
  },
);

it('rolls back candidate geometry, actors, RNG and IDs on a journal failure while retaining work', async () => {
  const battle = await terrainBattle();
  const world = createBattleWorld(battle);
  const budget = { ...DEFAULT_BUDGET, maxBytes: 1 };
  const previous = {
    actors: battle.actors.map((actor) => initialActor(world, actor)),
    melees: [],
    projectiles: [],
    ledger: new HitLedger(),
    serial: 7,
  };
  const snapshot = world.world.takeSnapshot(),
    before = structuredClone(previous.actors);
  const tx = new StepTransaction(
    { battle, world, budget, navigators: new Map(), work: new WorkMeter(budget) },
    previous,
    1,
    0,
    0,
    'boundary',
  );
  try {
    world.casts = 0;
    tx.replaceGeometry([...terrainObstacles(battle.scenario), barrier('both')]);
    tx.next.actors[0]!.mind.random = 17;
    tx.next.actors[0]!.body.motion.position.x += 1;
    tx.next.serial++;
    expect(() => tx.journal.finish(tx.boundaryRecord())).toThrow('log-bytes');
    tx.discardWorld();
    expect(world.world.takeSnapshot()).toEqual(snapshot);
    expect(previous.actors).toEqual(before);
    expect(previous.serial).toBe(7);
    expect(world.casts).toBe(terrainObstacles(battle.scenario).length + 1);
    expect(tx.commitWorld(world)).toBe(world);
  } finally {
    tx.discardWorld();
    world.free();
  }
});

it('retains casts from a partially built candidate and leaves the old world usable', () => {
  const world = new SpatialWorld([], 1);
  try {
    expect(() => world.rebuild([barrier('both'), { ...barrier('both'), id: 'other' }])).toThrow(
      'casts',
    );
    expect(world.casts).toBe(2);
    expect(world.obstacles('attack')).toEqual([]);
  } finally {
    world.free();
  }
});
