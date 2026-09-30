import { z } from 'zod';
import { canonicalJson, compareIds, contentHash, deepFreeze } from './spatial/canonical.ts';
import { HashSchema, IdSchema, RefSchema } from './spatial/contracts.ts';

export const SKILL_PATHS = deepFreeze([
  { id: 'sword', name: '剣道', family: 'martial', role: 'continuous offense and defense' },
  { id: 'judo', name: '柔道', family: 'martial', role: 'active capture and posture control' },
  { id: 'aikido', name: '合気道', family: 'martial', role: 'redirect opposing action' },
  { id: 'karate', name: '空手道', family: 'martial', role: 'striking combinations and breaks' },
  { id: 'archery', name: '弓道', family: 'martial', role: 'range, sightline and aim' },
  { id: 'staff', name: '杖道', family: 'martial', role: 'distance and route control' },
  { id: 'dagger', name: '短剣道', family: 'martial', role: 'entry and brief openings' },
  { id: 'draw-sword', name: '抜刀道', family: 'martial', role: 'prepared decisive strike' },
  { id: 'spear', name: '槍道', family: 'martial', role: 'reach, thrust and interception' },
  { id: 'axe', name: '斧道', family: 'martial', role: 'heavy armor and posture break' },
  { id: 'shield', name: '盾道', family: 'martial', role: 'guard, protection and displacement' },
  { id: 'shinto', name: '神道', family: 'mystic', role: 'healing, protection and purification' },
  { id: 'renki', name: '錬気道', family: 'mystic', role: 'physical and mental enhancement' },
  { id: 'magic', name: '魔道', family: 'mystic', role: 'elements, affinity and formations' },
  { id: 'illusion-curse', name: '呪幻道', family: 'mystic', role: 'debuff, mind and perception' },
  { id: 'summoning', name: '召喚道', family: 'mystic', role: 'summon, command and possession' },
] as const);
export const SKILL_PATH_IDS = SKILL_PATHS.map((path) => path.id) as [
  (typeof SKILL_PATHS)[number]['id'],
  ...(typeof SKILL_PATHS)[number]['id'][],
];
export const SkillPathIdSchema = z.enum(SKILL_PATH_IDS);
export type SkillPathId = z.infer<typeof SkillPathIdSchema>;

export const SKILL_ZODIACS = deepFreeze([
  { id: 'rat', name: '子', tendency: 'initiative' },
  { id: 'ox', name: '丑', tendency: 'accumulation' },
  { id: 'tiger', name: '寅', tendency: 'pressure' },
  { id: 'rabbit', name: '卯', tendency: 'evasion' },
  { id: 'dragon', name: '辰', tendency: 'area' },
  { id: 'snake', name: '巳', tendency: 'restraint' },
  { id: 'horse', name: '午', tendency: 'mobility' },
  { id: 'goat', name: '未', tendency: 'harmony' },
  { id: 'monkey', name: '申', tendency: 'adaptation' },
  { id: 'rooster', name: '酉', tendency: 'observation' },
  { id: 'dog', name: '戌', tendency: 'protection' },
  { id: 'boar', name: '亥', tendency: 'breakthrough' },
] as const);
export const SKILL_ZODIAC_IDS = SKILL_ZODIACS.map((zodiac) => zodiac.id) as [
  (typeof SKILL_ZODIACS)[number]['id'],
  ...(typeof SKILL_ZODIACS)[number]['id'][],
];
export const SkillZodiacIdSchema = z.enum(SKILL_ZODIAC_IDS);
export type SkillZodiacId = z.infer<typeof SkillZodiacIdSchema>;

export const SKILL_DANS = deepFreeze([
  { dan: 1, name: '初段', deepening: 'foundation' },
  { dan: 2, name: '二段', deepening: 'application' },
  { dan: 3, name: '三段', deepening: 'combination' },
  { dan: 4, name: '四段', deepening: 'tactics' },
  { dan: 5, name: '五段', deepening: 'secret' },
  { dan: 6, name: '六段', deepening: 'ultimate' },
] as const);
export const SkillDanSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export type SkillDan = z.infer<typeof SkillDanSchema>;

export const SkillCoordinateSchema = z.strictObject({
  path: SkillPathIdSchema,
  zodiac: SkillZodiacIdSchema,
  dan: SkillDanSchema,
});
export type SkillCoordinate = z.infer<typeof SkillCoordinateSchema>;
export const skillCoordinateKey = ({ path, zodiac, dan }: SkillCoordinate) =>
  `${path}:${zodiac}:${dan}`;

export const EXPECTED_SKILL_COORDINATES = deepFreeze(
  SKILL_PATH_IDS.flatMap((path) =>
    SKILL_ZODIAC_IDS.flatMap((zodiac) => SKILL_DANS.map(({ dan }) => ({ path, zodiac, dan }))),
  ),
);

const SkillResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('active-ability'), ability: RefSchema }),
  z.strictObject({ kind: z.literal('passive-ability'), ability: RefSchema }),
  z.strictObject({
    kind: z.literal('augment'),
    baseAbilityId: IdSchema,
    resolvedAbility: RefSchema,
  }),
]);
export type SkillResolution = z.infer<typeof SkillResolutionSchema>;
export const SkillLifecycleSchema = z.enum(['draft', 'implemented', 'available', 'retired']);
export const SkillDeepeningSchema = z.enum([
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
]);
const SKILL_DAN_DEEPENING = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const;

export const SkillNodeSchema = z
  .strictObject({
    id: IdSchema,
    coordinate: SkillCoordinateSchema,
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2_000),
    lifecycle: SkillLifecycleSchema,
    prerequisites: z.array(IdSchema).max(32),
    weaponTags: z.array(IdSchema).min(1).max(8).optional(),
    deepening: z.strictObject({
      kind: SkillDeepeningSchema,
      explanation: z.string().min(1).max(1_000),
      retainsLowerUse: z.boolean(),
      conditionOrTradeoff: z.string().min(1).max(1_000).optional(),
    }),
    pathRoleTags: z.array(IdSchema).min(1).max(8),
    resolution: z.array(SkillResolutionSchema).max(8),
    fixtureIds: z.array(IdSchema).max(16),
  })
  .superRefine((node, context) => {
    for (const [name, values] of [
      ['prerequisite', node.prerequisites],
      ['weapon tag', node.weaponTags ?? []],
      ['path role tag', node.pathRoleTags],
      ['fixture ID', node.fixtureIds],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', message: `Duplicate skill ${name}` });
    if (node.prerequisites.includes(node.id))
      context.addIssue({ code: 'custom', message: 'Skill cannot require itself' });
    if (node.lifecycle === 'available') {
      if (!node.resolution.length)
        context.addIssue({ code: 'custom', message: 'Available skill requires a resolution' });
      if (!node.fixtureIds.length)
        context.addIssue({ code: 'custom', message: 'Available skill requires fixture evidence' });
    }
    if (node.coordinate.dan === 1 && node.deepening.kind !== 'foundation')
      context.addIssue({ code: 'custom', message: 'First dan must be a foundation' });
    if (node.coordinate.dan > 1 && node.deepening.kind === 'foundation')
      context.addIssue({ code: 'custom', message: 'Only first dan may be a foundation' });
    if (node.coordinate.dan >= 5 && !node.deepening.conditionOrTradeoff)
      context.addIssue({ code: 'custom', message: 'Upper dan requires a condition or tradeoff' });
    if (!node.deepening.retainsLowerUse)
      context.addIssue({ code: 'custom', message: 'Every dan must retain a use for lower skills' });
    const expectedDeepening = SKILL_DAN_DEEPENING[node.coordinate.dan - 1]!;
    if (node.deepening.kind !== expectedDeepening)
      context.addIssue({
        code: 'custom',
        message: `Dan ${node.coordinate.dan} requires ${expectedDeepening} deepening`,
      });
  });
export type SkillNode = z.infer<typeof SkillNodeSchema>;

export const SkillCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  revision: z.number().int().min(1).max(1_000_000),
  nodes: z.array(SkillNodeSchema).max(1_152),
});
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;

export type SkillCatalogCode =
  | 'duplicate-node'
  | 'duplicate-coordinate'
  | 'missing-coordinate'
  | 'missing-prerequisite'
  | 'prerequisite-cycle';
export class SkillCatalogError extends Error {
  readonly code: SkillCatalogCode;
  constructor(code: SkillCatalogCode, message: string) {
    super(message);
    this.name = 'SkillCatalogError';
    this.code = code;
  }
}

export type SkillCatalogReport = {
  nodes: number;
  branches: number;
  paths: Record<SkillPathId, number>;
  zodiacs: Record<SkillZodiacId, number>;
  dans: Record<`${SkillDan}`, number>;
};

export function parseCompleteSkillCatalog(input: unknown): SkillCatalog {
  const catalog = SkillCatalogSchema.parse(input),
    expected = new Set(EXPECTED_SKILL_COORDINATES.map(skillCoordinateKey)),
    nodes = new Map<string, SkillNode>(),
    coordinates = new Set<string>();
  for (const node of catalog.nodes) {
    if (nodes.has(node.id))
      throw new SkillCatalogError('duplicate-node', `Duplicate skill node: ${node.id}`);
    const { weaponTags, ...nodeWithoutWeaponTags } = node,
      normalizedNode: SkillNode = {
        ...nodeWithoutWeaponTags,
        prerequisites: [...node.prerequisites].sort(compareIds),
        ...(weaponTags ? { weaponTags: [...weaponTags].sort(compareIds) } : {}),
        pathRoleTags: [...node.pathRoleTags].sort(compareIds),
        fixtureIds: [...node.fixtureIds].sort(compareIds),
      },
      coordinate = skillCoordinateKey(normalizedNode.coordinate);
    if (coordinates.has(coordinate))
      throw new SkillCatalogError(
        'duplicate-coordinate',
        `Duplicate skill coordinate: ${coordinate}`,
      );
    nodes.set(normalizedNode.id, normalizedNode);
    coordinates.add(coordinate);
  }
  const missing = [...expected].filter((coordinate) => !coordinates.has(coordinate));
  if (missing.length)
    throw new SkillCatalogError(
      'missing-coordinate',
      `Missing ${missing.length} skill coordinates; first: ${missing[0]}`,
    );
  const active = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id))
      throw new SkillCatalogError('prerequisite-cycle', `Skill prerequisite cycle: ${id}`);
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node)
      throw new SkillCatalogError('missing-prerequisite', `Missing skill prerequisite: ${id}`);
    active.add(id);
    node.prerequisites.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  nodes.forEach((node) => node.prerequisites.forEach(visit));
  return SkillCatalogSchema.parse({
    ...catalog,
    nodes: [...nodes.values()].sort((a, b) => compareIds(a.id, b.id)),
  });
}

export function skillCatalogReport(catalog: SkillCatalog): SkillCatalogReport {
  const paths = Object.fromEntries(SKILL_PATH_IDS.map((id) => [id, 0])) as Record<
      SkillPathId,
      number
    >,
    zodiacs = Object.fromEntries(SKILL_ZODIAC_IDS.map((id) => [id, 0])) as Record<
      SkillZodiacId,
      number
    >,
    dans = Object.fromEntries(SKILL_DANS.map(({ dan }) => [String(dan), 0])) as Record<
      `${SkillDan}`,
      number
    >,
    branches = new Set<string>();
  for (const node of catalog.nodes) {
    paths[node.coordinate.path]++;
    zodiacs[node.coordinate.zodiac]++;
    dans[String(node.coordinate.dan) as `${SkillDan}`]++;
    branches.add(`${node.coordinate.path}:${node.coordinate.zodiac}`);
  }
  return { nodes: catalog.nodes.length, branches: branches.size, paths, zodiacs, dans };
}

export async function skillCatalogDigest(catalog: SkillCatalog) {
  return contentHash(JSON.parse(canonicalJson(parseCompleteSkillCatalog(catalog))));
}

export const SkillCatalogShardSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    catalogId: IdSchema,
    catalogRevision: z.number().int().min(1).max(1_000_000),
    path: SkillPathIdSchema,
    nodes: z.array(SkillNodeSchema).length(72),
  })
  .superRefine((shard, context) => {
    if (shard.nodes.some((node) => node.coordinate.path !== shard.path))
      context.addIssue({ code: 'custom', message: 'Shard contains a node from another path' });
    if (new Set(shard.nodes.map((node) => skillCoordinateKey(node.coordinate))).size !== 72)
      context.addIssue({ code: 'custom', message: 'Shard coordinates must be unique' });
  });
export const SkillCatalogIndexSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    revision: z.number().int().min(1).max(1_000_000),
    shards: z
      .array(
        z.strictObject({ path: SkillPathIdSchema, nodes: z.literal(72), contentHash: HashSchema }),
      )
      .length(16),
  })
  .refine(
    (index) =>
      new Set(index.shards.map((shard) => shard.path)).size === SKILL_PATH_IDS.length &&
      SKILL_PATH_IDS.every((path) => index.shards.some((shard) => shard.path === path)),
    'Catalog index requires every path exactly once',
  );
