import { describe, expect, it } from 'vite-plus/test';
import { assertJson, canonicalJson, contentHash } from './canonical.ts';
import { actorSeed, nextRandom } from './random.ts';
import {
  BodySchema,
  ScenarioSchema,
  ConditionSchema,
  DirectionSchema,
  Vec3Schema,
  parseJson,
  type Condition,
} from './contracts.ts';

describe('bounded 3D definitions', () => {
  it.each([NaN, Infinity, -Infinity, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER])(
    'rejects invalid coordinates %s',
    (x) => {
      expect(() => parseJson(Vec3Schema, { x, y: 0, z: 0 })).toThrow(/Non-finite|Invalid|Too big/);
    },
  );
  it('rejects empty directions, malformed capsules and offsets outside the body envelope', () => {
    expect(DirectionSchema.safeParse({ x: 0, y: 0, z: 0 }).success).toBe(false);
    const offset = { x: 0, y: 0, z: 0 };
    expect(
      BodySchema.safeParse({
        radiusMm: 300,
        heightMm: 500,
        eyeOffset: offset,
        muzzleOffset: offset,
        aimOffset: offset,
      }).success,
    ).toBe(false);
    expect(
      BodySchema.safeParse({
        radiusMm: 300,
        heightMm: 1800,
        eyeOffset: { ...offset, y: 1000 },
        muzzleOffset: offset,
        aimOffset: offset,
      }).success,
    ).toBe(false);
  });
  it('bounds conditions before recursion and rejects unsupported instructions', () => {
    let condition: Condition = { kind: 'always' };
    for (let i = 0; i < 4; i++) condition = { kind: 'not', child: condition };
    expect(parseJson(ConditionSchema, condition)).toEqual(condition);
    expect(() => parseJson(ConditionSchema, { kind: 'not', child: condition })).toThrow(
      /Non-finite|Invalid|Too big/,
    );
    expect(() => parseJson(ConditionSchema, { kind: 'javascript', source: 'return true' })).toThrow(
      /Non-finite|Invalid|Too big/,
    );
  });
  it('rejects cycles, sparse arrays, functions and oversized input before traversing schemas', () => {
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(() => assertJson(cyclic)).toThrow('Cyclic');
    expect(() => assertJson(Array(3))).toThrow('Sparse');
    expect(() => assertJson({ f: () => 1 })).toThrow('plain JSON');
    expect(() => assertJson('x'.repeat(1_400_000))).toThrow('budget');
    expect(() => assertJson([1, 2, 3], 2)).toThrow('budget');
  });
  it('rejects duplicate geometric navigation nodes and nodes outside the arena', () => {
    const scenario = {
      name: 'test',
      bounds: { min: { x: -1000, y: 0, z: -1000 }, max: { x: 1000, y: 2000, z: 1000 } },
      obstacles: [],
      navigation: {
        version: 'support-graph-v1',
        nodes: [{ id: 'a', mode: 'ground', position: { x: 0, y: 902, z: 0 } }],
        edges: [],
      },
    };
    expect(ScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(
      ScenarioSchema.safeParse({
        ...scenario,
        navigation: {
          ...scenario.navigation,
          nodes: [...scenario.navigation.nodes, { ...scenario.navigation.nodes[0], id: 'b' }],
        },
      }).success,
    ).toBe(false);
    expect(
      ScenarioSchema.safeParse({
        ...scenario,
        navigation: {
          ...scenario.navigation,
          nodes: [{ ...scenario.navigation.nodes[0], position: { x: 1001, y: 902, z: 0 } }],
        },
      }).success,
    ).toBe(false);
  });
  it('rejects mixed-layer and incompatible-mode navigation edges before execution', () => {
    for (const from of ['ground', 'air'] as const)
      for (const to of ['ground', 'air'] as const)
        for (const mode of ['walk', 'jump', 'fly'] as const) {
          const scenario = {
            name: 'test',
            bounds: { min: { x: -1000, y: 0, z: -1000 }, max: { x: 1000, y: 2000, z: 1000 } },
            obstacles: [],
            navigation: {
              version: 'support-graph-v1',
              nodes: [
                { id: 'a', mode: from, position: { x: -500, y: 902, z: 0 } },
                { id: 'b', mode: to, position: { x: 500, y: 902, z: 0 } },
              ],
              edges: [
                { from: 'a', to: 'b', mode, widthMm: 1000, headroomMm: 2000, bidirectional: true },
              ],
            },
          };
          const required = mode === 'fly' ? 'air' : 'ground';
          expect(ScenarioSchema.safeParse(scenario).success).toBe(
            from === required && to === required,
          );
        }
  });
  it('keeps integer vector differences and squared lengths safely representable', () => {
    const worstSquaredDistance = 3 * (2 * 1_000_000) ** 2;
    const worstDirectionDot = 3 * 1_000_000 ** 2;
    expect(Number.isSafeInteger(worstSquaredDistance)).toBe(true);
    expect(Number.isSafeInteger(worstDirectionDot)).toBe(true);
    expect(worstSquaredDistance).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
it('canonicalizes keys without erasing ordered arrays and uses a stable UTF-8 SHA-256 contract', async () => {
  expect(canonicalJson({ z: 2, a: { y: 1, b: -0 } })).toBe('{"a":{"b":0,"y":1},"z":2}');
  expect(await contentHash({ a: 1, b: 2 })).toBe(await contentHash({ b: 2, a: 1 }));
  expect(await contentHash([1, 2])).not.toBe(await contentHash([2, 1]));
  expect(await contentHash(null)).toBe(
    'sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  );
});
it('pins the PRNG and nonzero actor stream derivation without depending on actor IDs', () => {
  let value = 1;
  const values = Array.from({ length: 3 }, () => {
    value = nextRandom(value);
    return value;
  });
  expect(values).toEqual([270369, 67634689, 2647435461]);
  expect(actorSeed(0, 0)).not.toBe(actorSeed(0, 1));
  expect(actorSeed(0x9e3779b9, 0)).toBe(0x6d2b79f5);
});
