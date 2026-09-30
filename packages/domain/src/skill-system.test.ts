import { describe, expect, it } from 'vite-plus/test';
import {
  EXPECTED_SKILL_COORDINATES,
  SKILL_DANS,
  SKILL_PATH_IDS,
  SKILL_PATHS,
  SKILL_ZODIAC_IDS,
  SKILL_ZODIACS,
  SkillCatalogError,
  SkillCatalogIndexSchema,
  SkillCatalogShardSchema,
  parseCompleteSkillCatalog,
  skillCatalogDigest,
  skillCatalogReport,
  type SkillCatalog,
  type SkillDan,
  type SkillNode,
} from './skill-system.ts';

const hash = `sha256:${'1'.repeat(64)}`;
const deepening = (dan: SkillDan): SkillNode['deepening'] => ({
  kind:
    dan === 1
      ? 'foundation'
      : dan === 2
        ? 'conditional-effect'
        : dan === 3
          ? 'combination'
          : dan === 4
            ? 'tactical-mode'
            : dan === 5
              ? 'specialization'
              : 'ultimate-tradeoff',
  explanation: `meaningful change for dan ${dan}`,
  retainsLowerUse: true,
  ...(dan >= 5 ? { conditionOrTradeoff: 'finite resource and recovery opening' } : {}),
});
function completeCatalog(): SkillCatalog {
  const nodes = EXPECTED_SKILL_COORDINATES.map((coordinate) => {
    const id = `skill.${coordinate.path}.${coordinate.zodiac}.${coordinate.dan}`;
    return {
      id,
      coordinate,
      name: id,
      description: `Executable test definition for ${id}`,
      lifecycle: 'available' as const,
      prerequisites:
        coordinate.dan === 1
          ? []
          : [`skill.${coordinate.path}.${coordinate.zodiac}.${coordinate.dan - 1}`],
      deepening: deepening(coordinate.dan),
      pathRoleTags: [`role.${coordinate.path}`],
      resolution: [
        {
          kind: 'active-ability' as const,
          ability: {
            id: `ability.${coordinate.path}.${coordinate.zodiac}`,
            revision: 1,
            contentHash: hash,
          },
        },
      ],
      fixtureIds: [`fixture.${coordinate.path}.${coordinate.zodiac}`],
    };
  });
  return { schemaVersion: 1, id: 'skill-catalog-v1', revision: 1, nodes };
}

describe('skill system axes', () => {
  it('fixes the approved path, zodiac and dan sets in display order', () => {
    expect(SKILL_PATHS).toHaveLength(16);
    expect(SKILL_PATHS.filter((path) => path.family === 'martial')).toHaveLength(11);
    expect(SKILL_PATHS.filter((path) => path.family === 'mystic')).toHaveLength(5);
    expect(SKILL_ZODIACS.map((zodiac) => zodiac.name).join('')).toBe('子丑寅卯辰巳午未申酉戌亥');
    expect(SKILL_DANS.map(({ dan }) => dan)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(EXPECTED_SKILL_COORDINATES).toHaveLength(1_152);
  });

  it('reports the exact 1,152 coordinates and 192 branches', () => {
    const catalog = parseCompleteSkillCatalog(completeCatalog()),
      report = skillCatalogReport(catalog);
    expect(report.nodes).toBe(1_152);
    expect(report.branches).toBe(192);
    expect(Object.values(report.paths)).toEqual(SKILL_PATH_IDS.map(() => 72));
    expect(Object.values(report.zodiacs)).toEqual(SKILL_ZODIAC_IDS.map(() => 96));
    expect(Object.values(report.dans)).toEqual(SKILL_DANS.map(() => 192));
  });

  it('canonicalizes node enumeration before hashing', async () => {
    const catalog = completeCatalog(),
      reversed = { ...catalog, nodes: [...catalog.nodes].reverse() };
    expect(await skillCatalogDigest(catalog)).toBe(await skillCatalogDigest(reversed));
    expect(parseCompleteSkillCatalog(reversed).nodes.map((node) => node.id)).toEqual(
      parseCompleteSkillCatalog(catalog).nodes.map((node) => node.id),
    );
  });

  it('canonicalizes set-like node fields but preserves recipe order', async () => {
    const catalog = completeCatalog(),
      targetIndex = catalog.nodes.findIndex(
        ({ coordinate }) =>
          coordinate.path === 'sword' && coordinate.zodiac === 'rat' && coordinate.dan === 3,
      ),
      target = catalog.nodes[targetIndex]!;
    catalog.nodes[targetIndex] = {
      ...target,
      prerequisites: [...target.prerequisites, 'skill.sword.ox.1'],
      weaponTags: ['weapon.sword', 'grip.one-hand'],
      pathRoleTags: [...target.pathRoleTags, 'role.counter'],
      fixtureIds: [...target.fixtureIds, 'fixture.sword.counter'],
      resolution: [
        ...target.resolution,
        {
          kind: 'passive-ability',
          ability: { id: 'ability.order-sensitive', revision: 1, contentHash: hash },
        },
      ],
    };
    const permuted = {
      ...catalog,
      nodes: [...catalog.nodes].reverse().map((node) =>
        node.id === target.id
          ? {
              ...node,
              prerequisites: [...node.prerequisites].reverse(),
              weaponTags: [...node.weaponTags!].reverse(),
              pathRoleTags: [...node.pathRoleTags].reverse(),
              fixtureIds: [...node.fixtureIds].reverse(),
            }
          : node,
      ),
    };
    expect(await skillCatalogDigest(catalog)).toBe(await skillCatalogDigest(permuted));
    const recipeReversed = {
      ...catalog,
      nodes: catalog.nodes.map((node) =>
        node.id === target.id ? { ...node, resolution: [...node.resolution].reverse() } : node,
      ),
    };
    expect(await skillCatalogDigest(catalog)).not.toBe(await skillCatalogDigest(recipeReversed));
  });
});

describe('skill catalog validation', () => {
  it('rejects a missing coordinate', () => {
    const catalog = completeCatalog();
    catalog.nodes.pop();
    expect(() => parseCompleteSkillCatalog(catalog)).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({ code: 'missing-coordinate' }),
    );
  });

  it('rejects a duplicate coordinate even when node IDs differ', () => {
    const catalog = completeCatalog();
    catalog.nodes[1] = { ...catalog.nodes[0]!, id: 'skill.distinct-id' };
    expect(() => parseCompleteSkillCatalog(catalog)).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({ code: 'duplicate-coordinate' }),
    );
  });

  it('rejects missing and cyclic prerequisites', () => {
    const missing = completeCatalog();
    missing.nodes[0] = { ...missing.nodes[0]!, prerequisites: ['skill.missing'] };
    expect(() => parseCompleteSkillCatalog(missing)).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({ code: 'missing-prerequisite' }),
    );

    const cyclic = completeCatalog();
    cyclic.nodes[0] = { ...cyclic.nodes[0]!, prerequisites: [cyclic.nodes[1]!.id] };
    expect(() => parseCompleteSkillCatalog(cyclic)).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({ code: 'prerequisite-cycle' }),
    );
  });

  it('requires available nodes to resolve and carry fixture evidence', () => {
    const catalog = completeCatalog();
    catalog.nodes[0] = { ...catalog.nodes[0]!, resolution: [], fixtureIds: [] };
    expect(() => parseCompleteSkillCatalog(catalog)).toThrow(/requires a resolution/);
  });

  it('rejects duplicate set entries and dan deepening mismatches', () => {
    const duplicate = completeCatalog();
    duplicate.nodes[0] = { ...duplicate.nodes[0]!, fixtureIds: ['fixture.same', 'fixture.same'] };
    expect(() => parseCompleteSkillCatalog(duplicate)).toThrow(/Duplicate skill fixture ID/);

    const wrongDan = completeCatalog();
    wrongDan.nodes[1] = {
      ...wrongDan.nodes[1]!,
      deepening: { ...wrongDan.nodes[1]!.deepening, kind: 'tactical-mode' },
    };
    expect(() => parseCompleteSkillCatalog(wrongDan)).toThrow(/requires conditional-effect/);
  });

  it('binds each 72-node shard and the index to every path exactly once', () => {
    const catalog = completeCatalog(),
      nodes = catalog.nodes.filter((node) => node.coordinate.path === SKILL_PATH_IDS[0]);
    expect(
      SkillCatalogShardSchema.safeParse({
        schemaVersion: 1,
        catalogId: catalog.id,
        catalogRevision: catalog.revision,
        path: SKILL_PATH_IDS[0],
        nodes,
      }).success,
    ).toBe(true);
    const shards = SKILL_PATH_IDS.map((path) => ({ path, nodes: 72 as const, contentHash: hash }));
    expect(
      SkillCatalogIndexSchema.safeParse({
        schemaVersion: 1,
        id: catalog.id,
        revision: catalog.revision,
        shards,
      }).success,
    ).toBe(true);
    expect(
      SkillCatalogIndexSchema.safeParse({
        schemaVersion: 1,
        id: catalog.id,
        revision: catalog.revision,
        shards: shards.map((shard) => ({ ...shard, path: SKILL_PATH_IDS[0] })),
      }).success,
    ).toBe(false);
  });
});
