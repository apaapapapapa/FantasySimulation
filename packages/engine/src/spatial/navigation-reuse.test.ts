import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Definition } from '@fantasy/domain/spatial/execution';
import { boxObstacle, terrainBattle } from '../../test-support/fixtures.ts';
import { initializePhysics } from './world/physics.ts';
import { createBattleWorld } from './world/terrain.ts';
import { Navigator } from './world/navigation.ts';
import { prepareNavigationGraph } from './world/navigation-graph.ts';

beforeAll(initializePhysics);
function graphInput(): Definition<'scenario'>['navigation'] {
  return {
    version: 'support-graph-v1',
    nodes: [
      { id: 'left', mode: 'ground', position: { x: -2000, y: 902, z: 2300 } },
      { id: 'right', mode: 'ground', position: { x: 2000, y: 902, z: 2300 } },
      { id: 'air', mode: 'air', position: { x: 0, y: 5000, z: 0 } },
    ],
    edges: [
      {
        from: 'left',
        to: 'right',
        mode: 'walk',
        widthMm: 1000,
        headroomMm: 3000,
        bidirectional: true,
      },
    ],
  };
}
describe('reusable navigation topology and search workspace', () => {
  it('preserves adjacency order, parallel/reverse edges and self-edge precedence', () => {
    const input = graphInput(),
      edge = input.edges[0]!;
    input.edges.push(
      { ...edge, from: 'right', to: 'left', bidirectional: false },
      { ...edge, from: 'left', to: 'left' },
      { ...edge, to: 'air', mode: 'fly' },
    );
    const graph = prepareNavigationGraph(input, false);
    expect(graph.nodes.map((node) => node.id)).toEqual(['left', 'right']);
    expect(graph.points.get('left')).toEqual({ x: -2, y: 0.902, z: 2.3 });
    expect(graph.adjacent.get('left')?.map((entry) => entry.next)).toEqual([
      'right',
      'left',
      'air',
    ]);
    expect(graph.adjacent.get('right')?.map((entry) => entry.edge)).toEqual([
      input.edges[0],
      input.edges[1],
    ]);
    expect(prepareNavigationGraph(input, true).nodes.map((node) => node.id)).toEqual(['air']);
  });
  it('resets bounded searches, owns output coordinates and invalidates safely', async () => {
    const battle = await terrainBattle([
      boxObstacle('detour', { x: 0, y: 2000, z: 0 }, { x: 1000, y: 2000, z: 1800 }),
    ]);
    const world = createBattleWorld(battle);
    try {
      const scenario = { ...battle.scenario, navigation: graphInput() };
      const navigator = new Navigator(world, battle.actors[0], scenario, battle.rules);
      const from = { x: -4, y: 0.902, z: 0 },
        to = { x: 4, y: 0.902, z: 0 };
      world.casts = 0;
      const first = navigator.find(from, to, false, 30);
      const firstCasts = world.casts;
      expect(first).toMatchObject({ kind: 'path', visited: 4 });
      if (first.kind !== 'path') throw Error('Expected the authored detour');
      expect(first.waypoints.map((point) => point.position)).toEqual([
        { x: -2, y: 0.902, z: 2.3 },
        { x: 2, y: 0.902, z: 2.3 },
        to,
      ]);
      const retained = structuredClone(first);
      first.waypoints[0]!.position.x = 123;
      expect(navigator.find(from, to, false, 0)).toEqual({ kind: 'budget-exceeded', visited: 0 });
      navigator.find(to, from, false, 30);
      navigator.find(from, to, true, 0);
      expect(navigator.find(from, to, false, 30)).toEqual(retained);
      navigator.invalidate();
      world.casts = 0;
      expect(navigator.find(from, to, false, 30)).toEqual(retained);
      expect(world.casts).toBe(firstCasts);
    } finally {
      world.free();
    }
  });
});
