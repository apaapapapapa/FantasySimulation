import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  IdSchema,
  RefSchema,
  RevisionSchema,
  SKILL_ZODIAC_IDS,
  SkillCatalogShardSchema,
  SkillPathIdSchema,
  compareIds,
  parseJson,
  type SkillDan,
  type SkillNode,
} from '@fantasy/domain';

const MARTIAL_PATHS = [
  'judo',
  'aikido',
  'karate',
  'staff',
  'dagger',
  'draw-sword',
  'spear',
  'axe',
] as const;
const MartialPathSchema = z.enum(MARTIAL_PATHS);
const stringList = z
  .array(IdSchema)
  .min(1)
  .max(8)
  .refine((items) => new Set(items).size === items.length);
const PathProfileSchema = z.strictObject({
  id: MartialPathSchema,
  label: z.string().min(1).max(100),
  core: z.string().min(1).max(500),
  lowUse: z.string().min(1).max(500),
  secondary: z.string().min(1).max(500),
  weakness: z.string().min(1).max(500),
  roleTags: stringList,
  requiredMechanics: stringList,
  contrastPath: SkillPathIdSchema,
  contrast: z.string().min(1).max(1_000),
});
const ZodiacProfileSchema = z.strictObject({
  id: z.enum(SKILL_ZODIAC_IDS),
  label: z.string().min(1).max(100),
  operation: z.string().min(1).max(500),
  condition: z.string().min(1).max(500),
  tactic: z.string().min(1).max(500),
  cost: z.string().min(1).max(500),
  counter: z.string().min(1).max(500),
});
const ReleaseSchema = z.strictObject({
  nodeId: IdSchema,
  resolutionKind: z.enum(['active-ability', 'passive-ability']),
  proof: z.enum(['long-melee-thrust', 'observed-physical-parry']),
  ability: RefSchema,
  fixtureId: IdSchema,
});
const AuthoringSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    catalogId: IdSchema,
    catalogRevision: z.number().int().min(1).max(1_000_000),
    paths: z.array(PathProfileSchema).length(8),
    zodiacs: z.array(ZodiacProfileSchema).length(12),
    releases: z.array(ReleaseSchema).max(576),
  })
  .superRefine((source, context) => {
    if (
      new Set(source.paths.map(({ id }) => id)).size !== MARTIAL_PATHS.length ||
      MARTIAL_PATHS.some((id) => !source.paths.some((path) => path.id === id))
    )
      context.addIssue({ code: 'custom', message: 'Every SK-04 path must appear exactly once' });
    if (
      new Set(source.zodiacs.map(({ id }) => id)).size !== SKILL_ZODIAC_IDS.length ||
      SKILL_ZODIAC_IDS.some((id) => !source.zodiacs.some((zodiac) => zodiac.id === id))
    )
      context.addIssue({ code: 'custom', message: 'Every zodiac must appear exactly once' });
    if (new Set(source.releases.map(({ nodeId }) => nodeId)).size !== source.releases.length)
      context.addIssue({ code: 'custom', message: 'Released martial node IDs must be unique' });
  });

export const MartialSkillFixturesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogId: IdSchema,
  catalogRevision: z.number().int().min(1).max(1_000_000),
  branches: z
    .array(
      z.strictObject({
        id: IdSchema,
        path: MartialPathSchema,
        zodiac: z.enum(SKILL_ZODIAC_IDS),
        status: z.enum(['blocked', 'partial']),
        nodeIds: z.array(IdSchema).length(6),
        availableNodeIds: z.array(IdSchema).max(6),
        lowLevelUse: z.string().min(1).max(1_000),
        upperDanTradeoffs: z.array(z.string().min(1).max(1_000)).length(2),
        requiredMechanics: stringList,
        missingMechanics: z.array(IdSchema).max(8),
        expectedBehavior: z.string().min(1).max(1_000),
        counterplay: z.string().min(1).max(1_000),
      }),
    )
    .length(96),
  contrasts: z.array(
    z.strictObject({
      id: IdSchema,
      left: SkillPathIdSchema,
      right: SkillPathIdSchema,
      assertions: z.array(z.string().min(1).max(1_000)).min(1).max(2),
    }),
  ),
  evidence: z.array(
    z.strictObject({
      fixtureId: IdSchema,
      nodeId: IdSchema,
      resolutionKind: z.enum(['active-ability', 'passive-ability']),
      proof: z.enum(['long-melee-thrust', 'observed-physical-parry']),
      definition: RefSchema,
      assertions: z.array(z.string().min(1).max(1_000)).min(1).max(8),
    }),
  ),
});

type PathProfile = z.infer<typeof PathProfileSchema>;
type ZodiacProfile = z.infer<typeof ZodiacProfileSchema>;
const root = fileURLToPath(new URL('../', import.meta.url));
export const martialSkillDirectory = join(root, 'data/skills/martial-eight-v1');

const deepeningKinds = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const;
const nodeId = (path: string, zodiac: string, dan: number) => `skill.${path}.${zodiac}.${dan}`;

function authoredNode(
  path: PathProfile,
  zodiac: ZodiacProfile,
  dan: SkillDan,
  release: z.infer<typeof ReleaseSchema> | undefined,
): SkillNode {
  const id = nodeId(path.id, zodiac.id, dan),
    lower = path.lowUse,
    descriptions = [
      `Low-level use: ${lower}. Zodiac direction: ${zodiac.operation}.`,
      `When ${zodiac.condition}, apply ${zodiac.operation}; retain the lower use: ${lower}.`,
      `Combine ${path.core} with ${path.secondary}; retain the lower use: ${lower}.`,
      `Tactical mode: ${zodiac.tactic}; retain the lower use: ${lower}.`,
      `Specialize ${path.core} for ${zodiac.operation}. Tradeoff: ${zodiac.cost}; ${path.weakness}.`,
      `Decisive use of ${path.core}. Tradeoffs remain: ${zodiac.cost}; ${path.weakness}. Counter: ${zodiac.counter}.`,
    ] as const,
    explanations = [
      `Foundation exposes ${path.lowUse} without promising the branch's advanced mechanisms.`,
      `Application is conditional on ${zodiac.condition} rather than a numeric replacement.`,
      `Combination adds ${path.secondary} while the foundation remains independently useful.`,
      `Tactical depth changes operation through ${zodiac.tactic}.`,
      `Specialization narrows the favorable situation and pays ${zodiac.cost}.`,
      `Ultimate use remains counterable by ${zodiac.counter} and preserves ${path.weakness}.`,
    ] as const;
  return {
    id,
    coordinate: { path: path.id, zodiac: zodiac.id, dan },
    name: `${path.label} ${zodiac.label} dan ${dan}`,
    description: descriptions[dan - 1]!,
    lifecycle: release ? 'available' : 'draft',
    prerequisites: dan === 1 ? [] : [nodeId(path.id, zodiac.id, dan - 1)],
    deepening: {
      kind: deepeningKinds[dan - 1]!,
      explanation: explanations[dan - 1]!,
      retainsLowerUse: true,
      ...(dan >= 5
        ? { conditionOrTradeoff: `${zodiac.cost}; retained weakness: ${path.weakness}.` }
        : {}),
    },
    pathRoleTags: [...path.roleTags],
    resolution: release ? [{ kind: release.resolutionKind, ability: release.ability }] : [],
    fixtureIds: release ? [release.fixtureId] : [],
  };
}

function requireReleasedDefinitions(
  releases: readonly z.infer<typeof ReleaseSchema>[],
  spatialInput: unknown,
) {
  const revisions = parseJson(RevisionSchema.array(), spatialInput),
    abilities = new Map(
      revisions
        .filter((revision) => revision.kind === 'ability')
        .map((revision) => [`${revision.id}@${revision.revision}`, revision]),
    );
  for (const release of releases) {
    const ability = abilities.get(`${release.ability.id}@${release.ability.revision}`);
    if (!ability || ability.contentHash !== release.ability.contentHash)
      throw new Error(`Missing exact martial release definition: ${release.nodeId}`);
    if (release.proof === 'long-melee-thrust') {
      if (
        release.resolutionKind !== 'active-ability' ||
        ability.definition.trigger !== 'action' ||
        ability.definition.attack.kind !== 'melee' ||
        ability.definition.attack.reachMm < 3_000 ||
        !ability.definition.effects.some((effect) => effect.kind === 'damage')
      )
        throw new Error(`Martial release lacks executable long-thrust evidence: ${release.nodeId}`);
    } else if (
      release.resolutionKind !== 'passive-ability' ||
      ability.definition.trigger !== 'before-hit' ||
      ability.definition.reaction?.response.kind !== 'parry' ||
      ability.definition.reaction.response.scope !== 'all' ||
      ability.definition.target !== 'self' ||
      !ability.definition.categories?.includes('technique') ||
      !ability.definition.reaction.categories?.includes('physical') ||
      !ability.definition.costs.stamina ||
      !ability.definition.cooldownSteps
    )
      throw new Error(`Martial release lacks observed physical parry evidence: ${release.nodeId}`);
  }
}

export function compileMartialSkillContent(authoringInput: unknown, spatialInput: unknown) {
  const source = AuthoringSchema.parse(authoringInput),
    releases = new Map(source.releases.map((release) => [release.nodeId, release]));
  requireReleasedDefinitions(source.releases, spatialInput);
  const shards = source.paths.map((path) =>
    SkillCatalogShardSchema.parse({
      schemaVersion: 1,
      catalogId: source.catalogId,
      catalogRevision: source.catalogRevision,
      path: path.id,
      nodes: source.zodiacs.flatMap((zodiac) =>
        ([1, 2, 3, 4, 5, 6] as const).map((dan) =>
          authoredNode(path, zodiac, dan, releases.get(nodeId(path.id, zodiac.id, dan))),
        ),
      ),
    }),
  );
  const supported = new Set([
      'explicit-reach',
      'linear-thrust',
      'observed-action-reaction',
      'redirect',
    ]),
    branches = source.paths.flatMap((path) =>
      source.zodiacs.map((zodiac) => {
        const nodeIds = [1, 2, 3, 4, 5, 6].map((dan) => nodeId(path.id, zodiac.id, dan)),
          availableNodeIds = nodeIds.filter((id) => releases.has(id));
        return {
          id: `fixture.plan.${path.id}.${zodiac.id}`,
          path: path.id,
          zodiac: zodiac.id,
          status: availableNodeIds.length ? ('partial' as const) : ('blocked' as const),
          nodeIds,
          availableNodeIds,
          lowLevelUse: path.lowUse,
          upperDanTradeoffs: [
            `${zodiac.cost}; ${path.weakness}.`,
            `${zodiac.cost}; ${path.weakness}; countered by ${zodiac.counter}.`,
          ],
          requiredMechanics: path.requiredMechanics,
          missingMechanics: path.requiredMechanics.filter((mechanic) => !supported.has(mechanic)),
          expectedBehavior: `${path.core}; zodiac behavior: ${zodiac.operation}.`,
          counterplay: `${zodiac.counter}; path weakness: ${path.weakness}.`,
        };
      }),
    ),
    contrasts = new Map<
      string,
      {
        id: string;
        left: z.infer<typeof SkillPathIdSchema>;
        right: z.infer<typeof SkillPathIdSchema>;
        assertions: string[];
      }
    >();
  for (const path of source.paths) {
    const pair = [path.id, path.contrastPath].sort(compareIds),
      id = `contrast.${pair[0]}.${pair[1]}`,
      existing = contrasts.get(id) ?? {
        id,
        left: SkillPathIdSchema.parse(pair[0]),
        right: SkillPathIdSchema.parse(pair[1]),
        assertions: [],
      };
    existing.assertions.push(path.contrast);
    contrasts.set(id, existing);
  }
  const fixtures = MartialSkillFixturesSchema.parse({
    schemaVersion: 1,
    catalogId: source.catalogId,
    catalogRevision: source.catalogRevision,
    branches,
    contrasts: [...contrasts.values()].sort((a, b) => compareIds(a.id, b.id)),
    evidence: source.releases.map((release) => ({
      fixtureId: release.fixtureId,
      nodeId: release.nodeId,
      resolutionKind: release.resolutionKind,
      proof: release.proof,
      definition: release.ability,
      assertions:
        release.proof === 'long-melee-thrust'
          ? [
              'exact immutable action ability revision',
              'melee reach is at least 3000mm',
              'exact loadout battle emits the selected ability',
              'recorded replay reaches the same final checkpoint',
            ]
          : [
              'exact immutable before-hit physical parry revision',
              'parry costs stamina and has a cooldown',
              'exact loadout battle records whole-contact parry activation',
              'recorded replay reaches the same final checkpoint',
            ],
    })),
  });
  return { source, shards, fixtures };
}

export function readMartialSkillContent() {
  const authoring: unknown = JSON.parse(
      readFileSync(join(martialSkillDirectory, 'authoring.json'), 'utf8'),
    ),
    spatial: unknown = JSON.parse(readFileSync(join(root, 'data/spatial/catalog.json'), 'utf8'));
  return compileMartialSkillContent(authoring, spatial);
}

export function writeMartialSkillContent() {
  const content = readMartialSkillContent();
  for (const shard of content.shards) {
    const path = join(martialSkillDirectory, `${shard.path}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(shard, null, 2) + '\n');
  }
  writeFileSync(
    join(martialSkillDirectory, 'fixtures.json'),
    JSON.stringify(content.fixtures, null, 2) + '\n',
  );
  return content;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write')
    throw new Error('Usage: node scripts/martial-skill-content.ts --write');
  const content = writeMartialSkillContent();
  console.log(
    `Wrote ${content.shards.length} martial skill shards, ${content.fixtures.branches.length} branch fixtures and ${content.fixtures.evidence.length} executable evidence case`,
  );
}
