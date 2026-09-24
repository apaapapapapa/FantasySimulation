import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { initializePhysics, SpatialWorld, type Obstacle } from './physics.ts';
import { prepareBattle } from './prepare.ts';
import { sampleManifest } from '@fantasy/samples';
import { initialMotion } from './movement.ts';
import {
  bodyPoint,
  canSee,
  conditionMatches,
  emptyMemory,
  perceive,
  type DecisionView,
} from './perception.ts';
import { choosePolicy } from './policy.ts';
beforeAll(initializePhysics);
const wall: Obstacle = {
  id: 'wall',
  position: { x: 0, y: 2, z: 0 },
  halfExtents: { x: 0.1, y: 2, z: 5 },
  blocks: { movement: true, vision: true, attack: true },
};
async function setup(obstacles: Obstacle[] = []) {
  const battle = await prepareBattle(await sampleManifest()),
    world = new SpatialWorld(obstacles);
  return {
    world,
    left: initialMotion(world, battle.actors[0]),
    right: initialMotion(world, battle.actors[1]),
  };
}
describe('legal observations and conditional policies', () => {
  it('delays observations by the declared reaction interval and snapshots positions before mutation', async () => {
    const { world, left, right } = await setup();
    try {
      let memory = perceive(world, left, right, [], 0, emptyMemory());
      expect(memory.observation).toBeNull();
      right.position.x = 9;
      memory = perceive(world, left, right, [], 4, memory);
      expect(memory.observation).toBeNull();
      memory = perceive(world, left, right, [], 5, memory);
      expect(memory.observation?.enemy?.position.x).toBe(4);
      expect(memory.pending[0]?.enemy?.position.x).toBe(9);
      expect(Object.isFrozen(memory.observation?.enemy?.position)).toBe(true);
    } finally {
      world.free();
    }
  });
  it('enforces range, field of view and vision flags independently of attack flags', async () => {
    const hidden = await setup([wall]);
    try {
      expect(canSee(hidden.world, hidden.left, hidden.right.position)).toBe(false);
    } finally {
      hidden.world.free();
    }
    const { world, left, right } = await setup([
      { ...wall, blocks: { ...wall.blocks, vision: false } },
    ]);
    try {
      expect(canSee(world, left, right.position)).toBe(true);
      expect(canSee(world, left, { x: -8, y: 0.902, z: 0 })).toBe(false);
      expect(canSee(world, left, { x: 99, y: 0.902, z: 0 })).toBe(false);
      expect(world.occluded(left.position, right.position, 'attack')).toBe(true);
      expect(
        bodyPoint(
          { position: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 } },
          { x: 1000, y: 500, z: 200 },
        ),
      ).toEqual({ x: -0.2, y: 0.5, z: 1 });
    } finally {
      world.free();
    }
  });
  it('uses last-seen memory without learning a hidden current position, then expires it', async () => {
    const { world, left, right } = await setup();
    try {
      let memory = perceive(world, left, right, [], 0, emptyMemory());
      right.position = { x: -10, y: 0.902, z: 0 };
      memory = perceive(world, left, right, [], 5, memory);
      memory = perceive(world, left, right, [], 10, memory);
      expect(memory.observation?.enemy).toBeNull();
      expect(memory.lastSeen?.position.x).toBe(4);
      const view: DecisionView = {
        self: left,
        resources: { hp: 100, mp: 20, shield: 0 },
        statusIds: [],
        memory,
      };
      const before = choosePolicy(view, new Set(['sword']), false);
      right.position = { x: -20, y: 4, z: 0 };
      expect(choosePolicy(view, new Set(['sword']), false)).toEqual(before);
      expect(conditionMatches({ kind: 'distance', withinMm: 8100 }, view)).toBe(true);
      memory = perceive(world, left, right, [], 251, memory);
      expect(memory.lastSeen).toBeNull();
    } finally {
      world.free();
    }
  });
  it('honors declared conditional priorities, readiness and configured flight altitude', async () => {
    const { world, left, right } = await setup();
    try {
      right.position.x = left.position.x + 1;
      let memory = perceive(world, left, right, [], 0, emptyMemory());
      memory = perceive(world, left, right, [], 5, memory);
      const sword = left.actor.abilities[0]!;
      const heal = {
        ...sword,
        id: 'heal',
        definition: {
          ...sword.definition,
          target: 'self' as const,
          attack: { kind: 'direct' as const },
          effects: [{ kind: 'heal' as const, amount: 10 }],
        },
      };
      const self = {
        ...left,
        actor: {
          ...left.actor,
          abilities: [sword, heal],
          policy: {
            ...left.actor.policy,
            priorities: [
              {
                when: { kind: 'resource' as const, resource: 'hp' as const, belowBps: 5000 },
                abilityId: 'heal',
              },
              { when: { kind: 'always' as const }, abilityId: sword.id },
            ],
            flightAltitudeMm: 5000,
          },
        },
      };
      const view: DecisionView = {
        self,
        memory,
        statusIds: [],
        resources: { hp: 10, mp: 20, shield: 0 },
      };
      expect(
        choosePolicy(view, new Set(['heal', sword.id]), false).cognition?.candidates.find(
          (c) => c.abilityId === 'heal',
        )?.weight,
      ).toBeGreaterThan(0);
      expect(choosePolicy(view, new Set([sword.id]), false).abilityId).toBe(sword.id);
      expect(
        choosePolicy(
          { ...view, resources: { ...view.resources, hp: 100 } },
          new Set(['heal', sword.id]),
          false,
        ).abilityId,
      ).toBe(sword.id);
      expect(choosePolicy(view, new Set(), true).goal?.y).toBe(5);
    } finally {
      world.free();
    }
  });
  it('does not give equidistant projectile enumeration a steering priority', async () => {
    const { world, left } = await setup();
    try {
      const projectiles = [
        {
          id: 'a',
          ownerId: 'right',
          position: { x: 0, y: 1, z: 1 },
          velocity: { x: -1, y: 0, z: -1 },
        },
        {
          id: 'b',
          ownerId: 'right',
          position: { x: 0, y: 1, z: -1 },
          velocity: { x: -1, y: 0, z: 1 },
        },
      ];
      const self = {
        ...left,
        actor: { ...left.actor, policy: { ...left.actor.policy, movement: 'evade' as const } },
      };
      const view: DecisionView = {
        self,
        resources: { hp: 100, mp: 0, shield: 0 },
        statusIds: [],
        memory: {
          ...emptyMemory(),
          observation: { sampledAt: 0, availableAt: 5, enemy: null, projectiles },
        },
      };
      const first = choosePolicy(view, new Set(), false);
      const reversed = {
        ...view,
        memory: {
          ...view.memory,
          observation: { ...view.memory.observation!, projectiles: [...projectiles].reverse() },
        },
      };
      expect(choosePolicy(reversed, new Set(), false)).toEqual(first);
    } finally {
      world.free();
    }
  });
  it('evades away from either side of an incoming projectile path and sidesteps vertical fire', async () => {
    const { world, left } = await setup();
    try {
      const self = {
        ...left,
        actor: { ...left.actor, policy: { ...left.actor.policy, movement: 'evade' as const } },
      };
      for (const z of [-1, 1]) {
        const memory = {
          ...emptyMemory(),
          observation: {
            sampledAt: 0,
            availableAt: 5,
            enemy: null,
            projectiles: [
              {
                id: 'arrow',
                ownerId: 'right',
                position: { x: 0, y: 1, z },
                velocity: { x: -10, y: 0, z: 0 },
              },
            ],
          },
        };
        const decision = choosePolicy(
          { self, memory, resources: { hp: 100, mp: 0, shield: 0 }, statusIds: [] },
          new Set(),
          false,
        );
        expect((decision.goal!.z - self.position.z) * z).toBeLessThan(0);
      }
      const memory = {
        ...emptyMemory(),
        observation: {
          sampledAt: 0,
          availableAt: 5,
          enemy: null,
          projectiles: [
            {
              id: 'vertical',
              ownerId: 'right',
              position: { ...left.position, y: 5 },
              velocity: { x: 0, y: -10, z: 0 },
            },
          ],
        },
      };
      const goal = choosePolicy(
        { self, memory, resources: { hp: 100, mp: 0, shield: 0 }, statusIds: [] },
        new Set(),
        false,
      ).goal!;
      expect(goal.y).toBe(self.position.y);
      expect(Math.hypot(goal.x - self.position.x, goal.z - self.position.z)).toBeGreaterThan(0);
    } finally {
      world.free();
    }
  });
  it('only exposes observed enemy projectiles and evaluates bounded ASTs against self resources', async () => {
    const { world, left, right } = await setup();
    try {
      const projectile = {
        id: 'arrow',
        ownerId: 'right',
        position: { x: 1, y: 1, z: 0 },
        velocity: { x: -10, y: 0, z: 0 },
      };
      let memory = perceive(
        world,
        left,
        right,
        [
          projectile,
          { ...projectile, id: 'own', ownerId: 'left' },
          { ...projectile, id: 'behind', position: { x: -10, y: 1, z: 0 } },
        ],
        0,
        emptyMemory(),
      );
      memory = perceive(world, left, right, [], 5, memory);
      expect(memory.observation?.projectiles.map((p) => p.id)).toEqual(['arrow']);
      const view: DecisionView = {
        self: left,
        resources: { hp: 10, mp: 0, shield: 0 },
        statusIds: ['burn'],
        memory,
      };
      expect(
        conditionMatches(
          {
            kind: 'all',
            children: [
              { kind: 'resource', resource: 'hp', belowBps: 5000 },
              { kind: 'status', id: 'burn', present: true },
              { kind: 'projectile-observed' },
            ],
          },
          view,
        ),
      ).toBe(true);
      expect(conditionMatches({ kind: 'not', child: { kind: 'visible', value: true } }, view)).toBe(
        false,
      );
      expect(choosePolicy(view, new Set(), false).abilityId).toBeNull();
      const decision = choosePolicy(view, new Set(left.actor.abilities.map((a) => a.id)), false);
      expect(decision.abilityId).toBeNull();
      expect(decision.cognition?.excluded).toContainEqual({
        abilityId: 'sword',
        reason: 'observed-range-or-facing',
      });
    } finally {
      world.free();
    }
  });
});
