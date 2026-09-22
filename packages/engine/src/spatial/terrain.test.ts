import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Definition, Manifest } from '@fantasy/domain/spatial';
import { at, ballShape, capsuleShape, initializePhysics } from './physics.ts';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { sampleManifest } from './sample.ts';
import { bodyCapsule, createBattleWorld, metres } from './terrain.ts';

beforeAll(initializePhysics);
const blocks = { movement: true, vision: true, attack: true };
const box = (
  id: string,
  center: { x: number; y: number; z: number },
  halfExtents: { x: number; y: number; z: number },
): Extract<Definition<'scenario'>['obstacles'][number], { kind: 'box' }> => ({
  id,
  kind: 'box',
  center,
  halfExtents,
  yawMilliDegrees: 0,
  slopeMilliDegrees: 0,
  blocks,
});
async function withTerrain(
  obstacles: Definition<'scenario'>['obstacles'],
  mutate?: (manifest: Manifest) => void,
) {
  const input = await sampleManifest();
  const old = input.revisions.find((r) => r.kind === 'scenario')!;
  const replacement = await sealRevision('scenario', old.id, 1, {
    ...old.definition,
    obstacles: [...old.definition.obstacles, ...obstacles],
  });
  input.revisions = input.revisions.map((r) => (r.kind === 'scenario' ? replacement : r));
  input.scenario = reference(replacement);
  mutate?.(input);
  return prepareBattle(input);
}
describe('3D static world', () => {
  it('retains ground and bridge deck as separate support heights', async () => {
    const battle = await withTerrain([
      box('bridge', { x: 0, y: 3000, z: 0 }, { x: 3000, y: 200, z: 2000 }),
    ]);
    const world = createBattleWorld(battle);
    try {
      const lower = world.raycast({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, 'movement');
      const upper = world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: 2, z: 0 }, 'movement');
      expect(lower?.point.y).toBeCloseTo(0, 6);
      expect(upper?.point.y).toBeCloseTo(3.2, 5);
      expect(upper?.obstacleId).toBe('bridge');
      const shape = capsuleShape(bodyCapsule(battle.actors[0].character.body));
      expect(world.overlaps({ x: 0, y: 0.902, z: 0 }, shape)).toBe(false);
      expect(world.overlaps({ x: 0, y: 4.102, z: 0 }, shape)).toBe(false);
      expect(world.overlaps({ x: 0, y: 2.7, z: 0 }, shape)).toBe(true);
    } finally {
      world.free();
    }
  });
  it('blocks an upward body sweep at a ceiling and preserves horizontal floor movement', async () => {
    const battle = await withTerrain([
      box('ceiling', { x: 0, y: 2200, z: 0 }, { x: 3000, y: 100, z: 3000 }),
    ]);
    const world = createBattleWorld(battle),
      body = bodyCapsule(battle.actors[0].character.body);
    try {
      const path = world.trace({ x: 0, y: 0.902, z: 0 }, { x: 0, y: 2, z: 0 }, body);
      expect(at(path, 1).y).toBeCloseTo(1.198, 3);
      expect(
        at(world.trace({ x: -4, y: 0.902, z: 0 }, { x: 2, y: 0, z: 0 }, body), 1).x,
      ).toBeCloseTo(-2, 5);
    } finally {
      world.free();
    }
  });
  it('lets vision cross a transparent wall while blocking bodies and attacks', async () => {
    const glass = {
      ...box('glass', { x: 0, y: 2000, z: 0 }, { x: 5, y: 2000, z: 2000 }),
      blocks: { movement: true, vision: false, attack: true },
    };
    const battle = await withTerrain([glass]);
    const world = createBattleWorld(battle);
    try {
      const from = { x: -2, y: 1.5, z: 0 },
        to = { x: 2, y: 1.5, z: 0 };
      expect(world.occluded(from, to, 'vision')).toBe(false);
      expect(world.occluded(from, to, 'attack')).toBe(true);
      expect(
        world.sweep(from, { x: 4, y: 0, z: 0 }, ballShape(0.001), 'attack')?.time_of_impact,
      ).toBeCloseTo(0.4985, 4);
      expect(
        at(world.trace(from, { x: 4, y: 0, z: 0 }, bodyCapsule(battle.actors[0].character.body)), 1)
          .x,
      ).toBeLessThan(-0.3);
    } finally {
      world.free();
    }
  });
  it('distinguishes eye visibility from a blocked lower muzzle', async () => {
    const battle = await withTerrain([
      box('cover', { x: 0, y: 650, z: 0 }, { x: 100, y: 650, z: 2000 }),
    ]);
    const world = createBattleWorld(battle);
    try {
      expect(world.occluded({ x: -2, y: 1.55, z: 0 }, { x: 2, y: 1.55, z: 0 }, 'vision')).toBe(
        false,
      );
      expect(world.occluded({ x: -2, y: 1.1, z: 0 }, { x: 2, y: 1.1, z: 0 }, 'attack')).toBe(true);
    } finally {
      world.free();
    }
  });
  it('uses actual cylinders and rotated slope geometry', async () => {
    const ramp = {
      ...box('ramp', { x: 0, y: 1000, z: 5_000 }, { x: 2000, y: 100, z: 2000 }),
      kind: 'box' as const,
      yawMilliDegrees: 0,
      slopeMilliDegrees: 30000,
    };
    const battle = await withTerrain([
      {
        id: 'pillar',
        kind: 'pillar',
        center: { x: 0, y: 2000, z: 0 },
        radiusMm: 1000,
        halfHeightMm: 2000,
        blocks,
      },
      ramp,
    ]);
    const world = createBattleWorld(battle);
    try {
      expect(world.occluded({ x: -0.9, y: 1, z: 0.9 }, { x: -0.9, y: 3, z: 0.9 }, 'attack')).toBe(
        false,
      );
      expect(world.occluded({ x: 0, y: 1, z: -2 }, { x: 0, y: 1, z: 2 }, 'attack')).toBe(true);
      const lower = world.raycast({ x: -0.5, y: 4, z: 5 }, { x: -0.5, y: 0, z: 5 }, 'movement');
      const upper = world.raycast({ x: 0.5, y: 4, z: 5 }, { x: 0.5, y: 0, z: 5 }, 'movement');
      expect(upper!.point.y - lower!.point.y).toBeCloseTo(0.57735, 4);
    } finally {
      world.free();
    }
  });
  it('rejects floor, ceiling and participant overlap before starting simulation', async () => {
    const insideFloor = await withTerrain([], (input) => {
      input.participants[0].position.y = 800;
    });
    expect(() => createBattleWorld(insideFloor)).toThrow('Spawn overlaps terrain');
    const insideCeiling = await withTerrain([
      box('low-ceiling', { x: -4000, y: 1500, z: 0 }, { x: 1000, y: 100, z: 1000 }),
    ]);
    expect(() => createBattleWorld(insideCeiling)).toThrow('Spawn overlaps terrain');
    const overlap = await withTerrain([], (input) => {
      input.participants[1].position = { ...input.participants[0].position };
    });
    expect(() => createBattleWorld(overlap)).toThrow('Spawn bodies overlap');
  });
  it('keeps bodies inside the declared arena without adding an out-of-bounds defeat rule', async () => {
    const battle = await withTerrain([]);
    const world = createBattleWorld(battle);
    try {
      const actor = battle.actors[0];
      const path = world.trace(
        metres(actor.participant.position),
        { x: 100, y: 0, z: 0 },
        bodyCapsule(actor.character.body),
      );
      expect(at(path, 1).x).toBeCloseTo(49.698, 3);
    } finally {
      world.free();
    }
  });
});
