import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Definition, Manifest } from '@fantasy/domain/spatial';
import { encodeNumericState, mul, ZERO } from './math.ts';
import { initializePhysics } from './physics.ts';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { sampleManifest } from './sample.ts';
import { bodyCapsule, createBattleWorld } from './terrain.ts';
import { capsuleShape } from './physics.ts';
import { initialMotion, moveActors, type MotionIntent } from './movement.ts';

beforeAll(initializePhysics);
const intent = (direction = { x: 1, y: 0, z: 0 }): MotionIntent => ({
  direction,
  facing: direction,
  jump: false,
  flight: false,
  canMove: true,
  speedBps: 10000,
});
async function scene(
  obstacles: Definition<'scenario'>['obstacles'] = [],
  edit?: (manifest: Manifest) => void,
) {
  const input = await sampleManifest();
  const old = input.revisions.find((r) => r.kind === 'scenario')!;
  const terrain = await sealRevision('scenario', old.id, 1, {
    ...old.definition,
    obstacles: [...old.definition.obstacles, ...obstacles],
  });
  input.revisions = input.revisions.map((r) => (r.kind === 'scenario' ? terrain : r));
  input.scenario = reference(terrain);
  edit?.(input);
  const battle = await prepareBattle(input);
  return { battle, world: createBattleWorld(battle) };
}
const step = (
  id: string,
  x: number,
  height: number,
  slope = 0,
): Extract<Definition<'scenario'>['obstacles'][number], { kind: 'box' }> => ({
  id,
  kind: 'box',
  center: { x, y: height / 2, z: 0 },
  halfExtents: { x: 1000, y: height / 2, z: 2000 },
  yawMilliDegrees: 0,
  slopeMilliDegrees: slope,
  blocks: { movement: true, vision: true, attack: true },
});
describe('simultaneous fixed-step locomotion', () => {
  it('walks continuously over flat terrain without tangential-contact sticking or floor penetration', async () => {
    const { world, battle } = await scene();
    let state = initialMotion(world, battle.actors[0]);
    try {
      const before = structuredClone(state);
      for (let i = 0; i < 200; i++)
        state = moveActors(world, [state], new Map([['left', intent()]]), battle.rules)[0]!.state;
      expect(state.position.x).toBeGreaterThan(10);
      expect(state.position.y).toBeGreaterThanOrEqual(0.89999);
      expect(state.position.y).toBeLessThan(0.903);
      expect(
        world.overlaps(state.position, capsuleShape(bodyCapsule(state.actor.character.body))),
      ).toBe(false);
      expect(before.position.x).toBe(-4);
    } finally {
      world.free();
    }
  });
  it('stops both actors symmetrically and gives the same result under reversed enumeration', async () => {
    async function run(reverse: boolean) {
      const { world, battle } = await scene();
      let states = battle.actors.map((actor) => initialMotion(world, actor));
      if (reverse) states.reverse();
      const requests = new Map([
        ['left', intent()],
        ['right', intent({ x: -1, y: 0, z: 0 })],
      ]);
      try {
        for (let i = 0; i < 150; i++)
          states = moveActors(world, states, requests, battle.rules).map((r) => r.state);
        return states.sort((a, b) =>
          a.actor.participant.actorId < b.actor.participant.actorId ? -1 : 1,
        );
      } finally {
        world.free();
      }
    }
    const states = await run(false),
      reversed = await run(true);
    expect(encodeNumericState(states)).toEqual(encodeNumericState(reversed));
    expect(states[0]!.position.x).toBeCloseTo(-states[1]!.position.x, 3);
    expect(states[1]!.position.x - states[0]!.position.x).toBeCloseTo(0.6, 3);
  });
  it('allows touching actors to separate, without pushing the stationary opponent', async () => {
    const { world, battle } = await scene([], (input) => {
      input.participants[0].position.x = -300;
      input.participants[1].position.x = 300;
    });
    try {
      const states = battle.actors.map((actor) => initialMotion(world, actor));
      const result = moveActors(
        world,
        states,
        new Map([
          ['left', intent({ x: -1, y: 0, z: 0 })],
          ['right', intent()],
        ]),
        battle.rules,
      );
      expect(result[0]!.state.position.x).toBeLessThan(-0.3);
      expect(result[1]!.state.position.x).toBeGreaterThan(0.3);
      expect(result[0]!.contactTime).toBeUndefined();
    } finally {
      world.free();
    }
  });
  it('jumps, falls under gravity, lands and computes damage from pre-contact downward speed', async () => {
    const { world, battle } = await scene();
    let state = initialMotion(world, battle.actors[0]);
    try {
      state = moveActors(
        world,
        [state],
        new Map([['left', { ...intent({ ...ZERO }), jump: true }]]),
        battle.rules,
      )[0]!.state;
      expect(state.position.y).toBeGreaterThan(0.95);
      expect(state.grounded).toBe(false);
      for (let i = 0; i < 80; i++)
        state = moveActors(
          world,
          [state],
          new Map([['left', intent({ ...ZERO })]]),
          battle.rules,
        )[0]!.state;
      expect(state.grounded).toBe(true);
      expect(state.position.y).toBeCloseTo(0.902, 2);
      state = {
        ...state,
        position: { x: -4, y: 10, z: 0 },
        velocity: { ...ZERO },
        grounded: false,
      };
      let damage = 0;
      for (let i = 0; i < 100; i++) {
        const result = moveActors(
          world,
          [state],
          new Map([['left', intent({ ...ZERO })]]),
          battle.rules,
        )[0]!;
        damage += result.fallDamage;
        state = result.state;
      }
      expect(state.grounded).toBe(true);
      expect(damage).toBeGreaterThan(0);
    } finally {
      world.free();
    }
  });
  it('retains the complete lift and traverse path for a legal step and rejects excessive height', async () => {
    const legal = await scene([step('step', 0, 200)]);
    let state = initialMotion(legal.world, legal.battle.actors[0]);
    let bent = false;
    let onTop = false;
    try {
      for (let i = 0; i < 75; i++) {
        const result = moveActors(
          legal.world,
          [state],
          new Map([['left', intent()]]),
          legal.battle.rules,
        )[0]!;
        bent ||= result.trace.length >= 2 && result.trace.some((s) => s.end.y - s.start.y > 0.1);
        state = result.state;
        onTop ||= Math.abs(state.position.x) < 0.8 && state.position.y > 1.09 && state.grounded;
      }
      expect(bent).toBe(true);
      expect(state.position.x).toBeGreaterThan(-0.8);
      expect(onTop).toBe(true);
    } finally {
      legal.world.free();
    }
    const tall = await scene([step('step', 0, 600)]);
    state = initialMotion(tall.world, tall.battle.actors[0]);
    try {
      for (let i = 0; i < 75; i++)
        state = moveActors(
          tall.world,
          [state],
          new Map([['left', intent()]]),
          tall.battle.rules,
        )[0]!.state;
      expect(state.position.x).toBeLessThan(-1.29);
    } finally {
      tall.world.free();
    }
  });
  it('climbs a walkable slope, rejects a steep one, and never overlaps the terrain', async () => {
    async function climb(slope: number) {
      const ramp = {
        ...step('ramp', 0, 200, slope),
        center: { x: 0, y: 0, z: 0 },
        halfExtents: { x: 2000, y: 100, z: 2000 },
      };
      const { world, battle } = await scene([ramp]);
      let state = initialMotion(world, battle.actors[0]),
        height = state.position.y;
      try {
        for (let i = 0; i < 120; i++) {
          state = moveActors(world, [state], new Map([['left', intent()]]), battle.rules)[0]!.state;
          height = Math.max(height, state.position.y);
          expect(
            world.overlaps(state.position, capsuleShape(bodyCapsule(state.actor.character.body))),
          ).toBe(false);
        }
        return { state, height };
      } finally {
        world.free();
      }
    }
    const gentle = await climb(30000),
      steep = await climb(60000);
    expect(gentle.height).toBeGreaterThan(1.5);
    expect(gentle.state.position.x).toBeGreaterThan(1);
    expect(steep.state.position.x).toBeLessThan(0);
    expect(steep.height).toBeLessThan(1.1);
  });
  it('blocks jumps at a ceiling, resumes gravity after flight expires, and honors movement budgets', async () => {
    const { world, battle } = await scene([
      { ...step('ceiling', -4000, 200), center: { x: -4000, y: 2200, z: 0 } },
    ]);
    let state = initialMotion(world, battle.actors[0]);
    try {
      let height = state.position.y;
      for (let i = 0; i < 60; i++) {
        state = moveActors(
          world,
          [state],
          new Map([['left', { ...intent({ ...ZERO }), jump: i === 0 }]]),
          battle.rules,
        )[0]!.state;
        height = Math.max(height, state.position.y);
      }
      expect(height).toBeLessThanOrEqual(1.198001);
      expect(state.grounded).toBe(true);
      state = { ...state, position: { x: -10, y: 5, z: 0 }, grounded: false };
      for (let i = 0; i < 20; i++)
        state = moveActors(
          world,
          [state],
          new Map([['left', { ...intent({ x: 0, y: 1, z: 0 }), flight: true }]]),
          battle.rules,
        )[0]!.state;
      expect(state.position.y).toBeGreaterThan(5);
      for (let i = 0; i < 100; i++)
        state = moveActors(
          world,
          [state],
          new Map([['left', intent({ ...ZERO })]]),
          battle.rules,
        )[0]!.state;
      expect(state.grounded).toBe(true);
      expect(() =>
        moveActors(world, [state], new Map([['left', intent()]]), battle.rules, 0),
      ).toThrow('movement-segments');
    } finally {
      world.free();
    }
  });
  it('treats 20ms as a deterministic interval independent of input identity order', async () => {
    const { world, battle } = await scene();
    try {
      const start = initialMotion(world, battle.actors[0]);
      const input = structuredClone(start);
      const moved = moveActors(world, [start], new Map([['left', intent()]]), battle.rules)[0]!;
      expect(start).toEqual(input);
      expect(moved.state.velocity.x).toBeCloseTo(0.24, 6);
      expect(moved.state.position.x - start.position.x).toBeCloseTo(0.0048, 6);
      expect(moved.trace[0]!.from).toBe(0);
      expect(moved.trace.at(-1)!.to).toBe(1);
      expect(mul(moved.state.facing, -1).x).toBeLessThan(0);
    } finally {
      world.free();
    }
  });
});
