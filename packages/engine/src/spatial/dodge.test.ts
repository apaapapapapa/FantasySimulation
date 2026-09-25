import type { DecisionView } from './state.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { initializePhysics, SpatialWorld } from './world/physics.ts';
import { dodgeOptions } from './ai/dodge.ts';
import { choosePolicy } from './ai/policy.ts';
import { initialDecisionRandom } from './ai/decision-random.ts';
import { Navigator } from './world/navigation.ts';
import { dodgeFixture } from '../../test-support/ai.ts';

beforeAll(initializePhysics);
describe('conditional observed 3D evasion', () => {
  it('draws four equivalent executable directions after choosing dodge, with separate reproducible purpose state', async () => {
    const f = await dodgeFixture();
    try {
      const options = dodgeOptions(f.view, true, () => true);
      expect(options.map((d) => d.weight)).toEqual([100, 100, 100, 100]);
      const selected = new Set<string>();
      for (let seed = 1; seed <= 32; seed++) {
        const random = initialDecisionRandom(seed),
          d = choosePolicy(f.view, new Set(), true, random);
        expect(d.cognition!.selection).toBe('dodge');
        expect(d.cognition!.draws[0]).toMatchObject({
          purpose: 'action',
          before: random.action,
          after: random.action,
          draws: 0,
        });
        expect(d.cognition!.draws[1]!.draws).toBe(1);
        selected.add(d.cognition!.draws[1]!.selection);
        expect(choosePolicy(f.view, new Set(), true, random)).toEqual(d);
      }
      expect([...selected].sort()).toEqual(['down', 'left', 'right', 'up']);
    } finally {
      f.world.free();
    }
  });
  it('excludes unsupported vertical motion, insufficient reaction and immobility', async () => {
    const f = await dodgeFixture();
    try {
      expect(dodgeOptions(f.view, false, () => true).map((d) => d.weight)).toEqual([
        0, 0, 100, 100,
      ]);
      for (const edit of [{ canMove: false }, { step: 39 }])
        expect(
          dodgeOptions({ ...f.view, ...edit }, true, () => true).every((d) => d.weight === 0),
        ).toBe(true);
    } finally {
      f.world.free();
    }
  });
  it('uses known wall, ceiling and floor geometry; a sole escape consumes no direction draw', async () => {
    const f = await dodgeFixture();
    const world = new SpatialWorld([
      {
        id: 'ceiling',
        position: { ...f.self.position, y: f.self.position.y + 0.7 },
        halfExtents: { x: 3, y: 0.1, z: 3 },
        blocks: { movement: true, vision: true, attack: true },
      },
      {
        id: 'floor',
        position: { ...f.self.position, y: f.self.position.y - 0.7 },
        halfExtents: { x: 3, y: 0.1, z: 3 },
        blocks: { movement: true, vision: true, attack: true },
      },
      {
        id: 'left',
        position: { ...f.self.position, z: -0.7 },
        halfExtents: { x: 3, y: 3, z: 0.1 },
        blocks: { movement: true, vision: true, attack: true },
      },
    ]);
    try {
      const navigator = new Navigator(world, f.self.actor, f.battle.scenario, f.battle.rules);
      const clear = (
        from: DecisionView['self']['position'],
        to: DecisionView['self']['position'],
      ) => navigator.knownClearance(from, to);
      const d = choosePolicy(f.view, new Set(), true, initialDecisionRandom(1), clear);
      expect(d.cognition!.directions.map((d) => d.weight)).toEqual([0, 0, 0, 100]);
      expect(d.cognition!.draws[1]).toMatchObject({ selection: 'right', draws: 0 });
    } finally {
      world.free();
      f.world.free();
    }
  });
  it('increases the weight of safer directions using other visible threats, without looking ahead into the world', async () => {
    const f = await dodgeFixture();
    try {
      const observation = f.view.memory.observation!;
      const projectiles = [
        ...observation.projectiles,
        {
          ...observation.projectiles[0]!,
          id: 'side',
          position: { ...observation.projectiles[0]!.position, z: 0.2 },
        },
      ];
      const view = {
        ...f.view,
        memory: { ...f.view.memory, observation: { ...observation, projectiles } },
      };
      const options = dodgeOptions(view, true, () => true);
      expect(options.find((d) => d.key === 'left')!.weight).toBeGreaterThan(
        options.find((d) => d.key === 'right')!.weight,
      );
      const reversed = {
        ...view,
        memory: {
          ...view.memory,
          observation: { ...view.memory.observation, projectiles: [...projectiles].reverse() },
        },
      };
      expect(choosePolicy(view, new Set(), true)).toEqual(choosePolicy(reversed, new Set(), true));
    } finally {
      f.world.free();
    }
  });
});
