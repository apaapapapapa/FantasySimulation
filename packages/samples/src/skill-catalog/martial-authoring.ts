import {
  SKILL_DANS,
  SkillCatalogShardSchema,
  type SkillDan,
  type SkillNode,
  type SkillPathId,
  type SkillZodiacId,
} from '@fantasy/domain';

export const MARTIAL_CATALOG_ID = 'skill-catalog-v1';
export const MARTIAL_CATALOG_REVISION = 2;

export type ExistingAbility = {
  id: string;
  revision: number;
  contentHash: `sha256:${string}`;
};

export type NodeEvidence =
  | {
      status: 'proven';
      ability: ExistingAbility;
      resolutionKind?: 'active-ability' | 'passive-ability';
      fixtureIds: readonly string[];
      evidenceFiles: readonly string[];
    }
  | {
      status: 'definition-only';
      ability: ExistingAbility;
      resolutionKind?: 'active-ability' | 'passive-ability';
      fixtureIds: readonly string[];
      evidenceFiles: readonly string[];
      releaseBlocker: string;
    }
  | {
      status: 'missing-mechanism';
      mechanismIds: readonly string[];
      releaseBlocker: string;
    };

export type DanPlan = {
  name: string;
  use: string;
  deepening: string;
  conditionOrTradeoff?: string;
};

export type BranchPlan = {
  zodiac: SkillZodiacId;
  branch: string;
  roleTags: readonly [string, ...string[]];
  missingMechanisms: readonly [string, ...string[]];
  dans: readonly [DanPlan, DanPlan, DanPlan, DanPlan, DanPlan, DanPlan];
};

export type PathEvidence = Readonly<Record<string, NodeEvidence>>;

const deepeningKinds = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const satisfies readonly SkillNode['deepening']['kind'][];

export const nodeId = (path: SkillPathId, zodiac: SkillZodiacId, dan: SkillDan) =>
  `skill.${path}.${zodiac}.${dan}`;

export function buildPathShard(
  path: SkillPathId,
  branches: readonly BranchPlan[],
  evidence: PathEvidence,
) {
  const nodes = branches.flatMap((branch) =>
    SKILL_DANS.map(({ dan }, index): SkillNode => {
      const plan = branch.dans[index]!,
        id = nodeId(path, branch.zodiac, dan),
        proof: NodeEvidence = evidence[id] ?? {
          status: 'missing-mechanism',
          mechanismIds: branch.missingMechanisms,
          releaseBlocker: `Requires ${branch.missingMechanisms.join(', ')} and path-specific fixtures.`,
        },
        executable = proof.status !== 'missing-mechanism';
      return {
        id,
        coordinate: { path, zodiac: branch.zodiac, dan },
        name: plan.name,
        description: `${plan.use} Lower-dan techniques remain the lower-commitment option.`,
        lifecycle:
          proof.status === 'proven'
            ? 'available'
            : proof.status === 'definition-only'
              ? 'implemented'
              : 'draft',
        prerequisites: dan === 1 ? [] : [nodeId(path, branch.zodiac, (dan - 1) as SkillDan)],
        deepening: {
          kind: deepeningKinds[index]!,
          explanation: plan.deepening,
          retainsLowerUse: true,
          ...(plan.conditionOrTradeoff ? { conditionOrTradeoff: plan.conditionOrTradeoff } : {}),
        },
        pathRoleTags: [...branch.roleTags, `zodiac.${branch.zodiac}`],
        resolution: executable
          ? [{ kind: proof.resolutionKind ?? 'active-ability', ability: proof.ability }]
          : [],
        fixtureIds: executable ? [...proof.fixtureIds] : [],
      };
    }),
  );
  return SkillCatalogShardSchema.parse({
    schemaVersion: 1,
    catalogId: MARTIAL_CATALOG_ID,
    catalogRevision: MARTIAL_CATALOG_REVISION,
    path,
    nodes,
  });
}

export function evidenceForPath(
  path: SkillPathId,
  branches: readonly BranchPlan[],
  evidence: PathEvidence,
) {
  return branches.flatMap((branch) =>
    SKILL_DANS.map(({ dan }) => {
      const id = nodeId(path, branch.zodiac, dan);
      return {
        nodeId: id,
        evidence:
          evidence[id] ??
          ({
            status: 'missing-mechanism',
            mechanismIds: branch.missingMechanisms,
            releaseBlocker: `Requires ${branch.missingMechanisms.join(', ')} and path-specific fixtures.`,
          } satisfies NodeEvidence),
      };
    }),
  );
}
