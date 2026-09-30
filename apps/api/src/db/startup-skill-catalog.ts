import {
  EXPECTED_SKILL_COORDINATES,
  RevisionSchema,
  compareIds,
  inspectSkillCatalogRelease,
  parseJson,
  parseCompleteSkillCatalog,
  revisionReference,
  skillCoordinateKey,
  type Revision,
  type SkillCatalog,
  type SkillCatalogReleaseReport,
  type SkillDan,
  type SkillNode,
} from '@fantasy/domain';
import { integratedSkillShards } from '@fantasy/samples/authoring';

const catalogId = 'skill-catalog-v1';
const swordRatNodeId = (dan: SkillDan) => `skill.sword.rat.${dan}`;

const deepeningKinds = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const satisfies readonly SkillNode['deepening']['kind'][];
const deepeningKind = (dan: SkillDan): SkillNode['deepening']['kind'] => deepeningKinds[dan - 1]!;

const swordRatRelease = [
  {
    dan: 1,
    abilityId: 'sword',
    abilityRevision: 1,
    abilityHash: 'sha256:57dba4284d2a6b5edfeaf6e254ac3e9ed62496b646a6d6e2b658134399892fef',
    name: 'Opening cut',
    description: 'A direct sword cut that remains the low-commitment foundation of the branch.',
    explanation: 'Establishes the branch with the existing direct melee sword action.',
  },
  {
    dan: 2,
    abilityId: 'stamina-strike-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:d516c37829bbc6708998e73ba9ed58538d42a67495ff4b2ffd8b1e4b686671fc',
    name: 'Committed opening cut',
    description:
      'Spends stamina to preserve the opening cut while making resource readiness matter.',
    explanation: 'Adds a stamina admission condition instead of replacing the free foundation.',
  },
  {
    dan: 3,
    abilityId: 'return-cut-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:396d51406e90fb6d783f0b9037d39f6bcd7f8c034624096c90db34edf3934b7f',
    name: 'Opening return cut',
    description: 'Links the first cut to a separately timed and separately paid return strike.',
    explanation: 'Deepens the branch through a two-stage combination and a second-stage cost.',
  },
  {
    dan: 4,
    abilityId: 'dash-cut-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:83b5bde59f56974f3d5296cab92ad3ecab7ada9524e5acea37208c083cc8c20c',
    name: 'Advancing opening cut',
    description: 'Combines the opening attack with committed forward movement and knockback.',
    explanation: 'Adds a tactical approach mode with displacement and a cooldown.',
  },
  {
    dan: 5,
    abilityId: 'wide-sweep-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:aed1d678df594a94b60acf1a0d6ba191ac41a9e8c1da84703dd4dfaae8622a18',
    name: 'Opening circle',
    description: 'Trades a long active sweep, stamina and cooldown for radial space control.',
    explanation:
      'Specializes the initiative branch for nearby space rather than a single thrust line.',
    conditionOrTradeoff: 'Requires stamina and commits to a 20-step radial sweep and cooldown.',
  },
  {
    dan: 6,
    abilityId: 'wide-sweep-trained-v1',
    abilityRevision: 1,
    abilityHash: 'sha256:bab5ea0a1fcd1fc011581c516ec78303c61ba5c7ac7f85dda18e515aa789e76a',
    name: 'Decisive opening circle',
    description: 'Uses the reviewed trained radial action as a high-output but committed opener.',
    explanation:
      'Caps the slice with the existing attack-scaled sweep without removing its commitment.',
    conditionOrTradeoff: 'Retains the stamina cost, 20-step sweep, recovery opening and cooldown.',
  },
] as const satisfies readonly {
  dan: SkillDan;
  abilityId: string;
  abilityRevision: number;
  abilityHash: string;
  name: string;
  description: string;
  explanation: string;
  conditionOrTradeoff?: string;
}[];

export const STARTUP_SKILL_FIXTURE_IDS = swordRatRelease.map(
  ({ dan }) => `fixture.skill.sword.rat.${dan}.action`,
);

function abilityRevisions(input: unknown[]): Map<string, Extract<Revision, { kind: 'ability' }>> {
  const revisions = parseJson(RevisionSchema.array(), input),
    abilities = new Map<string, Extract<Revision, { kind: 'ability' }>>();
  for (const revision of revisions)
    if (revision.kind === 'ability') abilities.set(`${revision.id}@${revision.revision}`, revision);
  for (const entry of swordRatRelease) {
    const ability = abilities.get(`${entry.abilityId}@${entry.abilityRevision}`);
    if (!ability) throw new Error(`Missing startup skill ability: ${entry.abilityId}`);
    if (ability.contentHash !== entry.abilityHash)
      throw new Error(`Changed startup skill ability: ${entry.abilityId}`);
    if (ability.definition.trigger !== 'action')
      throw new Error(`Startup skill ability is not an action: ${entry.abilityId}`);
  }
  if (new Set(swordRatRelease.map(({ abilityId }) => abilityId)).size !== swordRatRelease.length)
    throw new Error('Startup skill abilities must be unique');
  return abilities;
}

function draftNode(coordinate: (typeof EXPECTED_SKILL_COORDINATES)[number]): SkillNode {
  const id = `skill.${coordinate.path}.${coordinate.zodiac}.${coordinate.dan}`,
    upper = coordinate.dan >= 5;
  return {
    id,
    coordinate,
    name: `Draft ${coordinate.path} ${coordinate.zodiac} dan ${coordinate.dan}`,
    description: 'Draft catalog slot. It has no executable effect and cannot enter a loadout.',
    lifecycle: 'draft',
    prerequisites: [],
    deepening: {
      kind: deepeningKind(coordinate.dan),
      explanation: 'Draft only; meaningful behavior and evidence have not been implemented.',
      retainsLowerUse: true,
      ...(upper
        ? { conditionOrTradeoff: 'Draft only; the required condition or tradeoff is undecided.' }
        : {}),
    },
    pathRoleTags: [`role.${coordinate.path}`],
    resolution: [],
    fixtureIds: [],
  };
}

/** Build the production startup catalog without copying all 1,152 nodes into battle manifests. */
export function readStartupSkillCatalog(revisionInput: unknown[]): SkillCatalog {
  const abilities = abilityRevisions(revisionInput),
    release = new Map(swordRatRelease.map((entry) => [entry.dan, entry]));
  return {
    schemaVersion: 1,
    id: catalogId,
    revision: 1,
    nodes: EXPECTED_SKILL_COORDINATES.map((coordinate) => {
      if (coordinate.path !== 'sword' || coordinate.zodiac !== 'rat') return draftNode(coordinate);
      const entry = release.get(coordinate.dan)!;
      return {
        id: swordRatNodeId(coordinate.dan),
        coordinate,
        name: entry.name,
        description: entry.description,
        lifecycle: 'available',
        prerequisites:
          coordinate.dan === 1 ? [] : [swordRatNodeId((coordinate.dan - 1) as SkillDan)],
        deepening: {
          kind: deepeningKind(coordinate.dan),
          explanation: entry.explanation,
          retainsLowerUse: true,
          ...('conditionOrTradeoff' in entry
            ? { conditionOrTradeoff: entry.conditionOrTradeoff }
            : {}),
        },
        pathRoleTags: ['continuous-offense-defense', 'initiative'],
        resolution: [
          {
            kind: 'active-ability',
            ability: revisionReference(
              abilities.get(`${entry.abilityId}@${entry.abilityRevision}`)!,
            ),
          },
        ],
        fixtureIds: [`fixture.skill.sword.rat.${coordinate.dan}.action`],
      };
    }),
  };
}

export function inspectStartupSkillCatalog(
  catalog: SkillCatalog,
  revisionInput: unknown[],
): SkillCatalogReleaseReport {
  const abilities = abilityRevisions(revisionInput),
    report = inspectSkillCatalogRelease(catalog, {
      definitionRefs: swordRatRelease
        .map(({ abilityId, abilityRevision }) =>
          revisionReference(abilities.get(`${abilityId}@${abilityRevision}`)!),
        )
        .sort((a, b) => compareIds(a.id, b.id)),
      fixtureIds: [...STARTUP_SKILL_FIXTURE_IDS],
    });
  if (
    report.available !== 6 ||
    report.verified !== 6 ||
    report.lifecycle.draft !== 1_146 ||
    report.issues.length
  )
    throw new Error('Startup skill catalog release evidence is incomplete');
  return report;
}

export const STARTUP_SKILL_ABILITY_IDS = swordRatRelease.map(({ abilityId }) => abilityId);

export const INTEGRATED_STARTUP_CATALOG_REVISION = 2;

const definitionRefs = (node: SkillNode) =>
  node.resolution.flatMap((resolution) =>
    resolution.kind === 'augment'
      ? [resolution.baseAbility, resolution.resolvedAbility]
      : [resolution.ability],
  );

function validateIntegratedDefinitions(catalog: SkillCatalog, revisionInput: unknown[]) {
  const revisions = parseJson(RevisionSchema.array(), revisionInput),
    abilities = new Map(
      revisions
        .filter(
          (revision): revision is Extract<Revision, { kind: 'ability' }> =>
            revision.kind === 'ability',
        )
        .map((revision) => [`${revision.id}@${revision.revision}`, revision]),
    ),
    refs = catalog.nodes.flatMap(definitionRefs);
  for (const ref of refs) {
    const ability = abilities.get(`${ref.id}@${ref.revision}`);
    if (!ability || ability.contentHash !== ref.contentHash)
      throw new Error(`Integrated skill definition is missing or changed: ${ref.id}`);
  }
  return refs;
}

/** Overlay every authored shard on the complete legacy skeleton as immutable catalog v1@2. */
export function readIntegratedStartupSkillCatalog(revisionInput: unknown[]): SkillCatalog {
  const legacy = readStartupSkillCatalog(revisionInput),
    authored = integratedSkillShards.flatMap(({ nodes }) => nodes),
    nodes = new Map(legacy.nodes.map((node) => [skillCoordinateKey(node.coordinate), node]));
  for (const node of authored) nodes.set(skillCoordinateKey(node.coordinate), node);
  const catalog = parseCompleteSkillCatalog({
    ...legacy,
    revision: INTEGRATED_STARTUP_CATALOG_REVISION,
    nodes: [...nodes.values()],
  });
  validateIntegratedDefinitions(catalog, revisionInput);
  return catalog;
}

export function inspectIntegratedStartupSkillCatalog(
  catalog: SkillCatalog,
  revisionInput: unknown[],
): SkillCatalogReleaseReport {
  const refs = validateIntegratedDefinitions(catalog, revisionInput),
    available = catalog.nodes.filter(({ lifecycle }) => lifecycle === 'available'),
    report = inspectSkillCatalogRelease(catalog, {
      definitionRefs: refs,
      fixtureIds: available.flatMap(({ fixtureIds }) => fixtureIds),
    });
  if (
    report.available !== 27 ||
    report.verified !== 27 ||
    report.lifecycle.implemented !== 4 ||
    report.lifecycle.draft !== 1_121 ||
    report.issues.length
  )
    throw new Error('Integrated startup skill catalog release evidence is incomplete');
  return report;
}
