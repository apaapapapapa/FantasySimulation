import { describe, expect, it } from 'vite-plus/test';
import {
  canonicalJson,
  createRevision,
  hashJson,
  sha256Text,
  TickAbilitySchema,
  TickCharacterSchema,
  TickRulesSchema,
  TickStrategySchema,
  validateTickManifest,
} from './index.ts';
import { damage, matchup, participant } from '../../../engine/fixtures/tick-v1/cases.ts';

describe('canonical-json-v1', () => {
  it('sorts object keys recursively but preserves array order and Unicode', async () => {
    expect(canonicalJson({ z: [2, 1], a: { 炎: 1, b: '回復' } })).toBe(
      '{"a":{"b":"回復","炎":1},"z":[2,1]}',
    );
    expect(await hashJson({ a: 1, b: 2 })).toBe(await hashJson({ b: 2, a: 1 }));
    expect(await hashJson([1, 2])).not.toBe(await hashJson([2, 1]));
    expect(await sha256Text('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('rejects non-JSON values and unsafe or fractional numbers', () => {
    for (const value of [
      undefined,
      NaN,
      Infinity,
      -0,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      1n,
      new Date(),
      () => 1,
      { x: undefined },
    ]) {
      expect(() => canonicalJson(value)).toThrow(/JSON/);
    }
  });

  it('rejects cycles, sparse/extended arrays, accessors and excessive complexity', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array<number>(3);
    sparse[0] = 1;
    sparse[2] = 2;
    const extended = Object.assign([1], { extra: 2 });
    const disguised = Object.assign(new Array<unknown>(1), { extra: 2 });
    const accessor = Object.defineProperty({}, 'value', {
      get: () => {
        throw new Error('must not execute');
      },
    });
    let deep: unknown = 0;
    for (let i = 0; i < 34; i++) deep = [deep];
    for (const value of [
      cycle,
      sparse,
      extended,
      disguised,
      accessor,
      deep,
      Array.from({ length: 20_001 }, () => 1),
      'x'.repeat(1_000_001),
    ]) {
      expect(() => canonicalJson(value)).toThrow(/JSON/);
    }
    expect(() => canonicalJson(accessor)).toThrow('accessors');
  });

  it('creates independent frozen revision snapshots', async () => {
    const input = { stats: { hp: 10 } };
    const revision = await createRevision('character.r1', input);
    input.stats.hp = 1;
    expect(revision.definition.stats.hp).toBe(10);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(revision.definition.stats)).toBe(true);
    expect(revision.contentHash).toBe(await hashJson({ stats: { hp: 10 } }));
  });
});

describe('tick manifest boundary', () => {
  async function input() {
    return structuredClone(
      await matchup(
        await participant('a', [damage(), { kind: 'wait' }]),
        await participant('b', [damage()]),
      ),
    );
  }

  it('normalizes the resolved ability collection without changing priority arrays or inputs', async () => {
    const original = await input();
    const reordered = structuredClone(original);
    reordered.participants.left.abilities.reverse();
    const snapshot = structuredClone(reordered);
    expect(await validateTickManifest(reordered)).toEqual(await validateTickManifest(original));
    expect(reordered).toEqual(snapshot);
    expect(Object.isFrozen(reordered)).toBe(false);
    const normalized = await validateTickManifest(reordered);
    expect(Object.isFrozen(normalized.participants.left.character.definition.stats)).toBe(true);
    expect(normalized.participants.left.strategy.definition.abilityRevisionIds).toEqual(
      original.participants.left.strategy.definition.abilityRevisionIds,
    );
  });

  it('rejects revision tampering, unresolved references and conflicting revision IDs', async () => {
    const tampered = await input();
    tampered.participants.left.character.definition.stats.attack++;
    await expect(validateTickManifest(tampered)).rejects.toThrow('hash mismatch');
    const missing = await input();
    missing.participants.left.strategy.definition.abilityRevisionIds = ['absent.r1'];
    await expect(validateTickManifest(missing)).rejects.toThrow('missing ability');
    const conflict = await input();
    conflict.participants.right.character.revisionId =
      conflict.participants.left.character.revisionId;
    await expect(validateTickManifest(conflict)).rejects.toThrow('Conflicting revision');
  });

  it('rejects invalid initial resources, duplicate abilities, self-matches and unsupported versions', async () => {
    const hp = await input();
    hp.scenario.definition.initialState.left.hp = 101;
    await expect(validateTickManifest(hp)).rejects.toThrow('initial resources');
    const duplicate = await input();
    duplicate.participants.left.abilities.push(duplicate.participants.left.abilities[0]!);
    await expect(validateTickManifest(duplicate)).rejects.toThrow('duplicate ability');
    const self = await input();
    self.participants.right = self.participants.left;
    await expect(validateTickManifest(self)).rejects.toThrow('different character');
    const manifest = await input();
    await expect(validateTickManifest({ ...manifest, schemaVersion: 1 })).rejects.toThrow(
      /schemaVersion/,
    );
    await expect(
      validateTickManifest({ ...manifest, random: { ...manifest.random, seed: 0 } }),
    ).rejects.toThrow(/seed/);
    await expect(
      validateTickManifest({ ...manifest, random: { ...manifest.random, algorithm: 'unknown' } }),
    ).rejects.toThrow(/algorithm/);
  });

  it('rejects P2/P6 effects, conditions and equipment instead of silently accepting them', async () => {
    const manifest = await input();
    const ability = manifest.participants.left.abilities[0]!.definition;
    for (const kind of ['move', 'shield', 'applyStatus', 'dispel', 'reflect', 'absolute-win']) {
      expect(TickAbilitySchema.safeParse({ ...ability, effect: { kind } }).success).toBe(false);
    }
    expect(TickAbilitySchema.safeParse({ ...ability, recoveryTicks: 0 }).success).toBe(false);
    expect(TickAbilitySchema.safeParse({ ...ability, condition: { hpBelow: 30 } }).success).toBe(
      false,
    );
    expect(
      TickCharacterSchema.safeParse({
        ...manifest.participants.left.character.definition,
        equipmentRevisionIds: ['sword.r1'],
      }).success,
    ).toBe(false);
    expect(TickStrategySchema.safeParse({ id: 'ai', kind: 'priority', rules: [] }).success).toBe(
      false,
    );
    expect(
      TickRulesSchema.safeParse({ ...manifest.rules.definition, certainHitVsCertainEvade: 'hit' })
        .success,
    ).toBe(false);
  });
});
