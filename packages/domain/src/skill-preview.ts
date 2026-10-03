import { z } from 'zod';
import {
  SKILL_ACQUISITION_POLICY_VERSION,
  SkillAcquisitionCapabilitiesSchema,
} from './skill-acquisition.ts';
import { SkillConfigurationV2Schema } from './skill-loadout.ts';
import { IdSchema, RefSchema } from './spatial/contracts.ts';
import {
  RevisionGraphError,
  revisionRefKey,
  type RevisionLookup,
} from './spatial/revision-graph.ts';
import { SkillRecipeError } from './spatial/skill-recipe.ts';
import {
  SkillApplicationError,
  resolveSkillAbilityApplications,
  applySkillAbilityApplications,
} from './spatial/skill-application.ts';
import {
  SKILL_CATALOG_NODE_COUNT,
  UniqueSkillNodeIdsSchema,
  parseCompleteSkillCatalog,
  type SkillCatalog,
} from './skill-system.ts';
import {
  SkillSelectionError,
  SkillSelectionReasonSchema,
  skillApplicabilityReasons,
  skillLearningReasons,
  skillEnabledLearningReasons,
  skillPrerequisiteClosure,
  inspectSkillEnabledNodes,
} from './skill-selection.ts';

// Read-only proposal; no IDs/versions for mutable acquisition or loadout heads are accepted.
export const SkillPreviewRequestSchema = z.strictObject({
  character: RefSchema,
  catalog: RefSchema,
  learnedNodeIds: UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT),
  enabledNodeIds: SkillConfigurationV2Schema.shape.enabledNodeIds,
});
export type SkillPreviewRequest = z.infer<typeof SkillPreviewRequestSchema>;
export const SkillPreviewReasonSchema = z.union([
  SkillSelectionReasonSchema,
  z.strictObject({
    code: z.literal('ability-application'),
    nodeId: IdSchema.optional(),
    abilityId: IdSchema.optional(),
    reason: z.enum([
      'active-trigger',
      'passive-trigger',
      'augment-identity',
      'augment-trigger',
      'augment-base-not-owned',
      'duplicate-augment',
      'conflicting-grant',
      'definition-reference',
    ]),
  }),
]);
export type SkillPreviewReason = z.infer<typeof SkillPreviewReasonSchema>;
export const MAX_SKILL_PREVIEW_REASONS = 128;
export const SkillPreviewResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(SKILL_ACQUISITION_POLICY_VERSION),
  proposal: SkillPreviewRequestSchema,
  eligibilityNodeIds: UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT),
  resolvedNodeIds: UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT),
  counts: z.strictObject({
    paths: z.number().int().min(0).max(16),
    active: z.number().int().min(0).max(SKILL_CATALOG_NODE_COUNT),
    passive: z.number().int().min(0).max(SKILL_CATALOG_NODE_COUNT),
  }),
  nodeReasons: z.array(SkillPreviewReasonSchema).max(MAX_SKILL_PREVIEW_REASONS),
  reasons: z.array(SkillPreviewReasonSchema).max(MAX_SKILL_PREVIEW_REASONS),
  reasonsTruncated: z.boolean(),
  canSave: z.boolean(),
});
export type SkillPreviewResponse = z.infer<typeof SkillPreviewResponseSchema>;

function applicationReason(error: unknown, nodeId?: string): SkillPreviewReason {
  if (error instanceof SkillRecipeError || error instanceof SkillApplicationError)
    return {
      code: 'ability-application',
      reason: error.code,
      abilityId: error.abilityId,
      ...(nodeId ? { nodeId } : {}),
    };
  if (error instanceof RevisionGraphError)
    return {
      code: 'ability-application',
      reason: 'definition-reference',
      ...(nodeId ? { nodeId } : {}),
    };
  throw error;
}

/** Same domain rules as acquisition/loadout saving; collects reasons without producing history. */
export function previewSkillSelection(
  catalogInput: SkillCatalog,
  proposalInput: unknown,
  capabilitiesInput: unknown,
  lookup: RevisionLookup,
): SkillPreviewResponse {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    proposal = SkillPreviewRequestSchema.parse(proposalInput),
    capabilities = SkillAcquisitionCapabilitiesSchema.parse(capabilitiesInput),
    byId = new Map(catalog.nodes.map((node) => [node.id, node])),
    learned = new Set(proposal.learnedNodeIds),
    tags = new Set(capabilities.equipmentTags),
    owned = new Set(capabilities.abilityRefs.map(revisionRefKey)),
    eligibilityNodeIds: string[] = [],
    nodeReasons: SkillPreviewReason[] = [],
    reasons: SkillPreviewReason[] = [];
  // Exact catalog content identity is checked by the storage boundary before this pure evaluator.
  if (catalog.id !== proposal.catalog.id || catalog.revision !== proposal.catalog.revision)
    throw new Error('Preview catalog mismatch');
  for (const node of catalog.nodes) {
    const unavailable = skillApplicabilityReasons(node, tags, owned);
    if (node.lifecycle !== 'available') continue;
    if (!unavailable.length) eligibilityNodeIds.push(node.id);
    nodeReasons.push(...unavailable);
    try {
      resolveSkillAbilityApplications(
        capabilities.abilityRefs,
        { kind: 'new-v2-write', resolutions: node.resolution },
        lookup,
      );
    } catch (error) {
      nodeReasons.push(applicationReason(error, node.id));
    }
  }
  const eligible = new Set(eligibilityNodeIds);
  for (const id of proposal.learnedNodeIds) {
    const node = byId.get(id);
    if (!node) reasons.push({ code: 'unknown-node', nodeId: id });
    else
      reasons.push(
        ...skillApplicabilityReasons(node, tags, owned),
        ...skillLearningReasons(node, { eligible, learned }),
      );
  }
  let resolvedNodeIds: string[] = [];
  try {
    resolvedNodeIds = skillPrerequisiteClosure(catalog.nodes, proposal.enabledNodeIds);
  } catch (error) {
    if (error instanceof SkillSelectionError) reasons.push(error.reason);
    else throw error;
  }
  const resolvedNodes = resolvedNodeIds.map((id) => byId.get(id)!);
  reasons.push(...skillEnabledLearningReasons(resolvedNodeIds, learned));
  for (const node of resolvedNodes) reasons.push(...skillApplicabilityReasons(node, tags, owned));
  const inspected = inspectSkillEnabledNodes(resolvedNodes);
  reasons.push(...inspected.reasons);
  try {
    const applications = resolveSkillAbilityApplications(
      capabilities.abilityRefs,
      { kind: 'new-v2-write', resolutions: resolvedNodes.flatMap((node) => node.resolution) },
      lookup,
    );
    applySkillAbilityApplications(capabilities.abilityRefs, applications);
  } catch (error) {
    reasons.push(applicationReason(error));
  }
  return SkillPreviewResponseSchema.parse({
    schemaVersion: 1,
    policyVersion: SKILL_ACQUISITION_POLICY_VERSION,
    proposal,
    eligibilityNodeIds,
    resolvedNodeIds,
    counts: inspected.counts,
    nodeReasons: nodeReasons.slice(0, MAX_SKILL_PREVIEW_REASONS),
    reasons: reasons.slice(0, MAX_SKILL_PREVIEW_REASONS),
    reasonsTruncated:
      nodeReasons.length > MAX_SKILL_PREVIEW_REASONS || reasons.length > MAX_SKILL_PREVIEW_REASONS,
    canSave: reasons.length === 0,
  });
}
