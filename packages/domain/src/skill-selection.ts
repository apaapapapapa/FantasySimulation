import { z } from 'zod';
import { IdSchema, RefSchema } from './spatial/contracts.ts';
import { compareIds } from './spatial/canonical.ts';
import {
  SKILL_CATALOG_NODE_COUNT,
  SkillCatalogSchema,
  SkillLifecycleSchema,
  UniqueSkillNodeIdsSchema,
  revisionRefKey,
  type SkillNode,
} from './skill-system.ts';

export const MAX_ENABLED_SKILL_PATHS = 2;
export const MAX_ACTIVE_SKILL_NODES = 8;
export const MAX_PASSIVE_SKILL_NODES = 4;

export const SkillSelectionReasonSchema = z.union([
  z.strictObject({
    code: z.enum([
      'unknown-node',
      'duplicate-node',
      'prerequisite-cycle',
      'not-eligible',
      'enabled-node-not-learned',
      'mixed-resolution-kind',
    ]),
    nodeId: IdSchema,
  }),
  z.strictObject({
    code: z.enum(['missing-prerequisite', 'unmet-learning-prerequisite']),
    nodeId: IdSchema,
    prerequisiteNodeId: IdSchema,
  }),
  z.strictObject({
    code: z.literal('unavailable-node'),
    nodeId: IdSchema,
    lifecycle: SkillLifecycleSchema,
  }),
  z.strictObject({ code: z.literal('weapon-requirement'), nodeId: IdSchema, weaponTag: IdSchema }),
  z.strictObject({
    code: z.literal('augment-base-not-owned'),
    nodeId: IdSchema,
    baseAbility: RefSchema,
  }),
  z.strictObject({
    code: z.enum(['enabled-path-limit', 'active-node-limit', 'passive-node-limit']),
    count: z.number().int().min(0).max(SKILL_CATALOG_NODE_COUNT),
    maximum: z.number().int().min(1).max(SKILL_CATALOG_NODE_COUNT),
  }),
]);
export type SkillSelectionReason = z.infer<typeof SkillSelectionReasonSchema>;

export class SkillSelectionError extends Error {
  readonly reason: SkillSelectionReason;
  constructor(reason: SkillSelectionReason) {
    super(`Invalid skill selection: ${reason.code}`);
    this.name = 'SkillSelectionError';
    this.reason = reason;
  }
}

export type SkillLearningSets = {
  eligible: ReadonlySet<string>;
  learned: ReadonlySet<string>;
};

/** Learning rules are independent of persistence and preserve prerequisite order. */
export function skillLearningReasons(
  node: SkillNode,
  sets: SkillLearningSets,
): SkillSelectionReason[] {
  return [
    ...(sets.eligible.has(node.id) ? [] : [{ code: 'not-eligible' as const, nodeId: node.id }]),
    ...node.prerequisites
      .filter((id) => !sets.learned.has(id))
      .map((prerequisiteNodeId) => ({
        code: 'unmet-learning-prerequisite' as const,
        nodeId: node.id,
        prerequisiteNodeId,
      })),
  ];
}

export function skillNodeDecision(
  node: SkillNode,
  sets: SkillLearningSets & { enabled: ReadonlySet<string> },
): {
  status: 'retired' | 'unsupported' | 'enabled' | 'learned' | 'locked' | 'learnable';
  reasons: SkillSelectionReason[];
} {
  const unavailable = skillAvailabilityReason(node);
  if (unavailable)
    return {
      status: node.lifecycle === 'retired' ? 'retired' : 'unsupported',
      reasons: [unavailable],
    };
  if (sets.enabled.has(node.id)) return { status: 'enabled', reasons: [] };
  if (sets.learned.has(node.id)) return { status: 'learned', reasons: [] };
  const reasons = skillLearningReasons(node, sets);
  return { status: reasons.length ? 'locked' : 'learnable', reasons };
}

export function skillAvailabilityReason(
  node: SkillNode,
): Extract<SkillSelectionReason, { code: 'unavailable-node' }> | undefined {
  return node.lifecycle !== 'available' || !node.resolution.length
    ? { code: 'unavailable-node', nodeId: node.id, lifecycle: node.lifecycle }
    : undefined;
}

export function skillEnabledLearningReasons(
  nodeIds: readonly string[],
  learned: ReadonlySet<string>,
): Array<{ code: 'enabled-node-not-learned'; nodeId: string }> {
  return nodeIds
    .filter((nodeId) => !learned.has(nodeId))
    .map((nodeId) => ({
      code: 'enabled-node-not-learned',
      nodeId,
    }));
}

/** Capability inputs must come from exact character/equipment definitions at the caller's boundary. */
export function skillEquipmentReasons(
  node: SkillNode,
  equipmentTags: ReadonlySet<string>,
): SkillSelectionReason[] {
  const unavailable = skillAvailabilityReason(node);
  if (unavailable) return [unavailable];
  return (node.weaponTags ?? [])
    .filter((tag) => !equipmentTags.has(tag))
    .map((weaponTag) => ({ code: 'weapon-requirement' as const, nodeId: node.id, weaponTag }));
}

export function skillApplicabilityReasons(
  node: SkillNode,
  equipmentTags: ReadonlySet<string>,
  abilityRefKeys: ReadonlySet<string>,
): SkillSelectionReason[] {
  return [
    ...skillEquipmentReasons(node, equipmentTags),
    ...node.resolution.flatMap((resolution) =>
      resolution.kind === 'augment' && !abilityRefKeys.has(revisionRefKey(resolution.baseAbility))
        ? [
            {
              code: 'augment-base-not-owned' as const,
              nodeId: node.id,
              baseAbility: resolution.baseAbility,
            },
          ]
        : [],
    ),
  ];
}

export function skillNodeKind(node: SkillNode): 'active' | 'passive' | 'mixed' {
  const active = node.resolution.some(({ kind }) => kind === 'active-ability'),
    passive = node.resolution.some(({ kind }) => kind !== 'active-ability');
  return active && passive ? 'mixed' : active ? 'active' : 'passive';
}

const SelectionNodesSchema = SkillCatalogSchema.shape.nodes;
const SelectionIdsSchema = UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT);

/** Bounded iterative DFS never returns a partial closure for unknown, broken or cyclic input. */
export function skillPrerequisiteClosure(
  nodesInput: SkillNode[],
  selectedIdsInput: string[],
): string[] {
  const parsed = SelectionNodesSchema.parse(nodesInput),
    selectedIds = SelectionIdsSchema.parse(selectedIdsInput),
    nodes = new Map<string, SkillNode>(),
    closed = new Set<string>(),
    active = new Set<string>();
  for (const node of parsed) {
    if (nodes.has(node.id))
      throw new SkillSelectionError({ code: 'duplicate-node', nodeId: node.id });
    nodes.set(node.id, node);
  }
  for (const nodeId of selectedIds) {
    if (!nodes.has(nodeId)) throw new SkillSelectionError({ code: 'unknown-node', nodeId });
    const stack = [{ nodeId, leaving: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.leaving) {
        active.delete(frame.nodeId);
        closed.add(frame.nodeId);
        continue;
      }
      if (closed.has(frame.nodeId)) continue;
      if (active.has(frame.nodeId))
        throw new SkillSelectionError({ code: 'prerequisite-cycle', nodeId: frame.nodeId });
      const node = nodes.get(frame.nodeId)!;
      active.add(frame.nodeId);
      stack.push({ nodeId: frame.nodeId, leaving: true });
      for (const prerequisiteNodeId of [...node.prerequisites].reverse()) {
        if (!nodes.has(prerequisiteNodeId))
          throw new SkillSelectionError({
            code: 'missing-prerequisite',
            nodeId: node.id,
            prerequisiteNodeId,
          });
        stack.push({ nodeId: prerequisiteNodeId, leaving: false });
      }
    }
  }
  return [...closed].sort(compareIds);
}

/** Counts and limit reasons use the same path → kind → active → passive order as saving. */
export function inspectSkillEnabledNodes(resolvedNodes: SkillNode[]) {
  const classified = resolvedNodes.map((node) => ({ node, kind: skillNodeKind(node) })),
    counts = {
      paths: new Set(resolvedNodes.map((node) => node.coordinate.path)).size,
      active: classified.filter(({ kind }) => kind === 'active').length,
      passive: classified.filter(({ kind }) => kind === 'passive').length,
    },
    reasons: SkillSelectionReason[] = [];
  if (counts.paths > MAX_ENABLED_SKILL_PATHS)
    reasons.push({
      code: 'enabled-path-limit',
      count: counts.paths,
      maximum: MAX_ENABLED_SKILL_PATHS,
    });
  for (const { node, kind } of classified)
    if (kind === 'mixed') reasons.push({ code: 'mixed-resolution-kind', nodeId: node.id });
  if (counts.active > MAX_ACTIVE_SKILL_NODES)
    reasons.push({
      code: 'active-node-limit',
      count: counts.active,
      maximum: MAX_ACTIVE_SKILL_NODES,
    });
  if (counts.passive > MAX_PASSIVE_SKILL_NODES)
    reasons.push({
      code: 'passive-node-limit',
      count: counts.passive,
      maximum: MAX_PASSIVE_SKILL_NODES,
    });
  return { counts, reasons };
}
