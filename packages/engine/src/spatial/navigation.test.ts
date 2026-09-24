import { decisionView, withAbilities } from '../../test-support/ai.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Definition } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { prepareBattle } from './prepare.ts';
import { editScenario } from '../../test-support/fixtures.ts';
import { sampleManifest } from '@fantasy/samples';
import { createBattleWorld } from './terrain.ts';
import { Navigator } from './navigation.ts';
import { choosePolicy, steerPolicy } from './policy.ts';
import { locomotion } from '../../test-support/locomotion.ts';
import { initialMotion } from './movement.ts';
import { emptyMemory, type DecisionView } from './perception.ts';
beforeAll(initializePhysics);
const blocks = { movement: true, vision: true, attack: true };
const wall: Definition<'scenario'>['obstacles'][number] = {
  id: 'block',
  kind: 'box',
  center: { x: 0, y: 2000, z: 0 },
  halfExtents: { x: 1000, y: 2000, z: 1800 },
  yawMilliDegrees: 0,
  slopeMilliDegrees: 0,
  blocks,
};
const navigation: Definition<'scenario'>['navigation'] = {
  version: 'support-graph-v1',
  nodes: [
    { id: 'a', mode: 'ground', position: { x: -2000, y: 902, z: 2300 } },
    { id: 'b', mode: 'ground', position: { x: 2000, y: 902, z: 2300 } },
  ],
  edges: [
    { from: 'a', to: 'b', mode: 'walk', widthMm: 1000, headroomMm: 3000, bidirectional: true },
  ],
};
async function setup(edit: (scenario: Definition<'scenario'>) => void = () => {}) {
  const manifest = await sampleManifest();
  await editScenario(manifest, edit);
  const battle = await prepareBattle(manifest),
    world = createBattleWorld(battle);
  return {
    world,
    battle,
    navigator: new Navigator(world, battle.actors[0], battle.scenario, battle.rules),
  };
}
const start = { x: -4, y: 0.902, z: 0 },
  goal = { x: 4, y: 0.902, z: 0 };
describe('bounded body-aware support graphs', () => {
  it('chooses a walk detour instead of an affordable but expensive jump', async () => {
    const scene = await setup((s) => {
      s.obstacles.push({
        ...wall,
        center: { x: 0, y: 100, z: 0 },
        halfExtents: { x: 1000, y: 100, z: 100 },
      });
      s.navigation = {
        version: 'support-graph-v1',
        nodes: [
          { id: 'near', mode: 'ground', position: { x: -1500, y: 902, z: 0 } },
          { id: 'far', mode: 'ground', position: { x: 1500, y: 902, z: 0 } },
          { id: 'around-a', mode: 'ground', position: { x: -1400, y: 902, z: 450 } },
          { id: 'around-b', mode: 'ground', position: { x: 1400, y: 902, z: 450 } },
        ],
        edges: [
          {
            from: 'near',
            to: 'far',
            mode: 'jump',
            widthMm: 1000,
            headroomMm: 5000,
            bidirectional: true,
          },
          {
            from: 'around-a',
            to: 'around-b',
            mode: 'walk',
            widthMm: 1000,
            headroomMm: 5000,
            bidirectional: true,
          },
        ],
      };
    });
    try {
      const resources = {
        speedMmPerSecond: 6000,
        stamina: 100,
        ready: true,
        walkPerMeter: 2,
        stepPerMeter: 10,
        flightPerSecond: 0,
        jumpStamina: 1,
      };
      const cheap = scene.navigator.find(start, goal, false, 30, true, resources);
      const costly = scene.navigator.find(start, goal, false, 30, true, {
        ...resources,
        jumpStamina: 90,
      });
      expect(cheap.kind).toBe('path');
      expect(costly.kind).toBe('path');
      if (cheap.kind !== 'path' || costly.kind !== 'path') throw Error('Expected both routes');
      expect(cheap.waypoints.some((w) => w.mode === 'jump')).toBe(true);
      expect(costly.waypoints.some((w) => w.mode === 'jump')).toBe(false);
      expect(costly.estimatedStamina).toBeLessThan(25);
      expect(costly.visited).toBeGreaterThanOrEqual(cheap.visited);
    } finally {
      scene.world.free();
    }
  });
  it('uses direct travel first, then detours around a solid obstruction independently of node enumeration', async () => {
    const flat = await setup();
    try {
      expect(flat.navigator.find(start, goal, false, 0)).toMatchObject({
        kind: 'path',
        visited: 0,
        waypoints: [{ position: goal }],
      });
    } finally {
      flat.world.free();
    }
    async function route(reverse: boolean) {
      const scene = await setup((s) => {
        s.obstacles.push(wall);
        s.navigation = structuredClone(navigation);
        if (reverse) s.navigation.nodes.reverse();
      });
      try {
        return scene.navigator.find(start, goal, false, 30);
      } finally {
        scene.world.free();
      }
    }
    const result = await route(false);
    expect(result.kind).toBe('path');
    if (result.kind !== 'path') throw new Error('Expected a body-clear route');
    expect(result.waypoints.length).toBeGreaterThanOrEqual(3);
    expect(await route(true)).toEqual(result);
  });
  it('distinguishes exhausted exploration from unreachable and respects width and headroom', async () => {
    for (const limit of ['budget', 'width', 'height'] as const) {
      const { world, navigator } = await setup((s) => {
        s.obstacles.push(wall);
        s.navigation = structuredClone(navigation);
        if (limit === 'width') s.navigation.edges[0]!.widthMm = 500;
        if (limit === 'height') s.navigation.edges[0]!.headroomMm = 1700;
      });
      try {
        expect(navigator.find(start, goal, false, limit === 'budget' ? 0 : 30).kind).toBe(
          limit === 'budget' ? 'budget-exceeded' : 'unreachable',
        );
      } finally {
        world.free();
      }
    }
  });
  it('retains independent bridge levels and air routes without granting ground actors flight', async () => {
    const { world, navigator } = await setup((s) => {
      s.obstacles.push({
        ...wall,
        id: 'bridge',
        center: { x: 0, y: 3000, z: 0 },
        halfExtents: { x: 3000, y: 200, z: 3000 },
      });
      s.navigation = { version: 'support-graph-v1', nodes: [], edges: [] };
    });
    try {
      expect(navigator.groundGoal({ x: 2, y: 4.102, z: 0 })).toEqual({ x: 2, y: 4.102, z: 0 });
      expect(navigator.groundGoal({ x: 2, y: 6, z: 0 }).y).toBeCloseTo(4.102, 5);
      expect(
        navigator.find({ x: -2, y: 0.902, z: 0 }, { x: 2, y: 0.902, z: 0 }, false, 20).kind,
      ).toBe('path');
      expect(
        navigator.find({ x: -2, y: 4.102, z: 0 }, { x: 2, y: 4.102, z: 0 }, false, 20).kind,
      ).toBe('path');
      expect(navigator.find(start, { x: 2, y: 4.102, z: 0 }, false, 20).kind).toBe('unreachable');
    } finally {
      world.free();
    }
    const air = await setup((s) => {
      s.obstacles.push(wall);
      s.navigation = structuredClone(navigation);
      s.navigation.nodes = s.navigation.nodes.map((n) => ({
        ...n,
        mode: 'air',
        position: { ...n.position, y: 5500, z: 0 },
      }));
      s.navigation.edges[0]!.mode = 'fly';
    });
    try {
      expect(air.navigator.find({ ...start, y: 2 }, { ...goal, y: 2 }, true, 30).kind).toBe('path');
      expect(air.navigator.find({ ...start, y: 2 }, { ...goal, y: 2 }, false, 30).kind).toBe(
        'unreachable',
      );
    } finally {
      air.world.free();
    }
  });
  it('validates a nearby legal step using lift and traverse clearance', async () => {
    const { world, navigator } = await setup((s) => {
      s.obstacles.push({
        ...wall,
        id: 'step',
        center: { x: 0, y: 100, z: 0 },
        halfExtents: { x: 1000, y: 100, z: 2000 },
      });
    });
    try {
      expect(
        navigator.find({ x: -1.3, y: 0.902, z: 0 }, { x: -0.7, y: 1.102, z: 0 }, false, 0).kind,
      ).toBe('path');
    } finally {
      world.free();
    }
  });
  it('requires support along walking edges and checks a jump arc across an unsupported gap', async () => {
    const { world, navigator, battle } = await setup((s) => {
      s.obstacles = [-1, 1].map((sign) => ({
        ...wall,
        id: sign < 0 ? 'leftfloor' : 'rightfloor',
        center: { x: sign * 25500, y: -500, z: 0 },
        halfExtents: { x: 24500, y: 500, z: 50000 },
      }));
      s.navigation = {
        version: 'support-graph-v1',
        nodes: [
          { id: 'a', mode: 'ground', position: { x: -1500, y: 902, z: 0 } },
          { id: 'b', mode: 'ground', position: { x: 1500, y: 902, z: 0 } },
        ],
        edges: [
          {
            from: 'a',
            to: 'b',
            mode: 'jump',
            widthMm: 3000,
            headroomMm: 5000,
            bidirectional: true,
          },
        ],
      };
    });
    try {
      const path = navigator.find(start, goal, false, 30);
      expect(path.kind).toBe('path');
      if (path.kind !== 'path') throw new Error('Expected a jump route');
      expect(path.waypoints.some((p) => p.mode === 'jump')).toBe(true);
      expect(navigator.find(start, goal, false, 30, false).kind).toBe('unreachable');
      const resources = {
        speedMmPerSecond: 6000,
        stamina: 7,
        ready: true,
        walkPerMeter: 2,
        jumpStamina: 8,
        stepPerMeter: 10,
        flightPerSecond: 0,
      };
      expect(navigator.find(start, goal, false, 30, true, resources).kind).toBe('resource-limited');
      const recovered = navigator.find(start, goal, false, 30, true, { ...resources, stamina: 20 });
      expect(recovered).toMatchObject({ kind: 'path', estimatedStamina: 24 });
      expect(
        navigator.find(start, goal, false, 30, true, {
          ...resources,
          stamina: 20,
          speedMmPerSecond: 2000,
        }).kind,
      ).toBe('unreachable');
      expect(navigator.find(start, goal, false, 30, true, { ...resources, stamina: 20 }).kind).toBe(
        'path',
      );
      const actor = {
        ...battle.actors[0],
        character: { ...battle.actors[0].character, stamina: { max: 20, recoveryPerSecond: 2 } },
      };
      const view: DecisionView = decisionView({
        self: initialMotion(world, actor),
        resources: { hp: 100, mp: 100, shield: 0, stamina: 0 },
        statusIds: [],
        memory: emptyMemory(),
      });
      const decision = { abilityId: null, goal, facing: { x: 1, y: 0, z: 0 } };
      const options = { flight: false, canMove: true, speedBps: 10000, maxPathNodes: 30 };
      const exhausted = steerPolicy(view, decision, navigator, options);
      expect(exhausted.navigation?.kind).toBe('resource-limited');
      expect(exhausted.intent.direction).toEqual({ x: 0, y: 0, z: 0 });
      expect(
        steerPolicy(
          { ...view, resources: { ...view.resources, stamina: 20 } },
          decision,
          navigator,
          options,
        ).navigation?.kind,
      ).toBe('path');
      const dodgeView: DecisionView = decisionView({
        ...view,
        self: {
          ...view.self,
          actor: {
            ...actor,
            character: {
              ...actor.character,
              movement: { ...actor.character.movement, locomotion: locomotion() },
            },
          },
        },
        resources: { ...view.resources, stamina: 12 },
      });
      const dodge = {
        ...decision,
        gait: 'run' as const,
        cognition: {
          ...choosePolicy(dodgeView, new Set(), false).cognition!,
          selection: 'dodge' as const,
        },
      };
      const combinedShortage = steerPolicy(dodgeView, dodge, navigator, options);
      expect(combinedShortage.navigation?.kind).toBe('resource-limited');
      expect(combinedShortage.intent.direction).toEqual({ x: 0, y: 0, z: 0 });
      expect(
        steerPolicy(
          { ...dodgeView, resources: { ...dodgeView.resources, stamina: 13 } },
          dodge,
          navigator,
          options,
        ).navigation?.kind,
      ).toBe('path');
      const ability = actor.abilities[0]!;
      const spendingView: DecisionView = decisionView({
        ...view,
        resources: { ...view.resources, stamina: 20 },
        self: {
          ...view.self,
          actor: withAbilities(actor, [
            {
              ...ability,
              definition: {
                ...ability.definition,
                costs: { ...ability.definition.costs, stamina: 20 },
              },
            },
          ]),
        },
      });
      expect(
        steerPolicy(spendingView, { ...decision, abilityId: ability.id }, navigator, options)
          .navigation?.kind,
      ).toBe('resource-limited');
    } finally {
      world.free();
    }
  });
});
