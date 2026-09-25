import { beforeAll, expect, it } from 'vite-plus/test';
import { catalogManifest, leagueStarts } from '@fantasy/samples';
import { initializePhysics } from './world/physics.ts';
import { prepareBattle } from './prepare.ts';
import { createBattleWorld } from './world/terrain.ts';
import { Navigator } from './world/navigation.ts';
import { runBattle } from './run.ts';

beforeAll(initializePhysics);
const fields = [
  'flat-surveyed-v1',
  'pillars-surveyed-v1',
  'elevation-surveyed-v1',
  'indoor-surveyed-v1',
  'aerial-surveyed-v1',
];
const pairs = [
  ['swordsman', 'swordsman'],
  ['swordsman', 'sky-mage'],
  ['sky-mage', 'sky-mage'],
] as const;
it.each(fields.flatMap((scenario) => pairs.map(([left, right]) => ({ scenario, left, right }))))(
  'permits actions for $left / $right in $scenario',
  async ({ scenario, left, right }) => {
    const manifest = await catalogManifest(left, right, scenario, 1200, 42, 'standard-tactics-v1');
    for (const [i, start] of leagueStarts(scenario).entries())
      Object.assign(manifest.participants[i]!, structuredClone(start));
    const run = await runBattle(manifest);
    expect(['win', 'draw']).toContain(run.result.outcome.kind);
    expect(
      run.records
        .flatMap((record) => ('events' in record ? record.events : []))
        .filter((event) => event.kind === 'launch').length,
    ).toBeGreaterThan(0);
    const paths = run.records.flatMap((record) => (record.kind === 'interval' ? record.paths : []));
    expect(
      paths.some((path) =>
        path.segments.some(
          (s) => s.start.x !== s.end.x || s.start.y !== s.end.y || s.start.z !== s.end.z,
        ),
      ),
    ).toBe(true);
    if (scenario === 'indoor-surveyed-v1')
      for (const path of paths)
        for (const segment of path.segments) expect(segment.end.y).toBeLessThanOrEqual(3.603);
  },
  15000,
);

it('keeps starts symmetric and offers a ground route up and down both stairways', async () => {
  for (const field of fields) {
    const [a, b] = leagueStarts(field);
    expect(a.position).toEqual({ x: -b.position.x, y: b.position.y, z: b.position.z });
    expect(a.facing.x).toBe(-b.facing.x);
  }
  const battle = await prepareBattle(
    await catalogManifest('swordsman', 'swordsman', 'elevation-surveyed-v1'),
  );
  const world = createBattleWorld(battle);
  try {
    const navigator = new Navigator(world, battle.actors[0], battle.scenario, battle.rules);
    for (const side of [-1, 1]) {
      const bottom = { x: side * -8.35, y: 0.902, z: side * 5.5 };
      const top = { x: 0, y: 2.402, z: side * 5.5 };
      expect(navigator.find(bottom, top, false, 100)).toMatchObject({ kind: 'path' });
      expect(navigator.find(top, bottom, false, 100)).toMatchObject({ kind: 'path' });
    }
  } finally {
    world.free();
  }
});

it('connects aerial platforms for ground actors and retains the floor below for normal falling', async () => {
  const battle = await prepareBattle(
    await catalogManifest('swordsman', 'swordsman', 'aerial-surveyed-v1'),
  );
  const world = createBattleWorld(battle);
  try {
    const navigator = new Navigator(world, battle.actors[0], battle.scenario, battle.rules);
    expect(
      navigator.find({ x: -6, y: 8.902, z: 0 }, { x: 6, y: 8.902, z: 0 }, false, 100),
    ).toMatchObject({ kind: 'path' });
    expect(
      world.raycast({ x: 0, y: 10, z: 5 }, { x: 0, y: -1, z: 5 }, 'movement')!.point.y,
    ).toBeCloseTo(0, 4);
    expect(battle.rules.fallDamagePerMeterPerSecond).toBe(5);
  } finally {
    world.free();
  }
});

it('connects the indoor hall to all four rooms through the doorways', async () => {
  const battle = await prepareBattle(
    await catalogManifest('swordsman', 'swordsman', 'indoor-surveyed-v1'),
  );
  const world = createBattleWorld(battle);
  try {
    const navigator = new Navigator(world, battle.actors[0], battle.scenario, battle.rules);
    for (const x of [-6, 6])
      for (const z of [-5, 5])
        expect(
          navigator.find({ x: 0, y: 0.902, z: 0 }, { x, y: 0.902, z }, false, 100),
        ).toMatchObject({ kind: 'path' });
  } finally {
    world.free();
  }
});
