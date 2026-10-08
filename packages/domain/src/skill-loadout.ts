import { z } from 'zod';
import { canonicalJson, compareIds, contentHash } from './spatial/canonical.ts';
import {
  HashSchema,
  IdSchema,
  RefSchema,
  CURRENT_SKILL_RESOLVER_VERSION,
  SkillLoadoutReceiptSchema,
  type RevisionRef,
  type SkillLoadoutReceipt,
} from './spatial/contracts.ts';
import {
  SKILL_CATALOG_NODE_COUNT,
  SkillResolutionSchema,
  type SkillCatalog,
  type SkillNode,
  UniqueSkillNodeIdsSchema,
  parseCompleteSkillCatalog,
  skillCatalogDigest,
} from './skill-system.ts';
import {
  SkillAcquisitionRevisionSchema,
  skillAcquisitionRevisionHash,
  type SkillAcquisitionRevision,
} from './skill-acquisition.ts';

import {
  MAX_ACTIVE_SKILL_NODES,
  MAX_PASSIVE_SKILL_NODES,
  inspectSkillEnabledNodes,
  skillEquipmentReasons,
  skillEnabledLearningReasons,
  skillLearningReasons,
  skillNodeDecision,
  skillPrerequisiteClosure,
} from './skill-selection.ts';

export const SKILL_RESOLVER_VERSION = CURRENT_SKILL_RESOLVER_VERSION;
export {
  MAX_ENABLED_SKILL_PATHS,
  MAX_ACTIVE_SKILL_NODES,
  MAX_PASSIVE_SKILL_NODES,
} from './skill-selection.ts';

const MAX_RESOLVED_SKILL_NODES = MAX_ACTIVE_SKILL_NODES + MAX_PASSIVE_SKILL_NODES;

export const SkillConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  version: z.number().int().min(1).max(1_000_000),
  catalog: RefSchema,
  eligibilityNodeIds: UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT),
  learnedNodeIds: UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT),
  enabledNodeIds: UniqueSkillNodeIdsSchema(MAX_RESOLVED_SKILL_NODES),
});
export type SkillConfiguration = z.infer<typeof SkillConfigurationSchema>;
export const SkillConfigurationV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  id: IdSchema,
  version: z.number().int().min(1).max(1_000_000),
  catalog: RefSchema,
  acquisition: RefSchema,
  enabledNodeIds: UniqueSkillNodeIdsSchema(MAX_RESOLVED_SKILL_NODES),
});
export type SkillConfigurationV2 = z.infer<typeof SkillConfigurationV2Schema>;
export const AnySkillConfigurationSchema = z.union([
  SkillConfigurationSchema,
  SkillConfigurationV2Schema,
]);
export type AnySkillConfiguration = z.infer<typeof AnySkillConfigurationSchema>;

export const SkillNodeStatusSchema = z.enum([
  'locked',
  'learnable',
  'learned',
  'enabled',
  'unsupported',
  'retired',
]);
export type SkillNodeStatus = z.infer<typeof SkillNodeStatusSchema>;
export type SkillNodeState = {
  nodeId: string;
  status: SkillNodeStatus;
  reasons: string[];
};

const resolvedSkillLoadoutFields = {
  resolverVersion: z.literal(SKILL_RESOLVER_VERSION),
  configurationId: IdSchema,
  configurationVersion: z.number().int().min(1).max(1_000_000),
  catalog: RefSchema,
  learnedNodeIds: UniqueSkillNodeIdsSchema(SKILL_CATALOG_NODE_COUNT),
  explicitlyEnabledNodeIds: UniqueSkillNodeIdsSchema(MAX_RESOLVED_SKILL_NODES),
  resolvedNodeIds: UniqueSkillNodeIdsSchema(MAX_RESOLVED_SKILL_NODES),
  nodeResolutions: z
    .array(
      z.strictObject({
        nodeId: IdSchema,
        resolution: z.array(SkillResolutionSchema).min(1).max(8),
      }),
    )
    .max(MAX_RESOLVED_SKILL_NODES),
  resolutionDigest: HashSchema,
};
export const ResolvedSkillLoadoutSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...resolvedSkillLoadoutFields,
});
export type ResolvedSkillLoadout = z.infer<typeof ResolvedSkillLoadoutSchema>;
export const ResolvedSkillLoadoutV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ...resolvedSkillLoadoutFields,
  acquisition: RefSchema,
});
export type ResolvedSkillLoadoutV2 = z.infer<typeof ResolvedSkillLoadoutV2Schema>;
export const AnyResolvedSkillLoadoutSchema = z.union([
  ResolvedSkillLoadoutSchema,
  ResolvedSkillLoadoutV2Schema,
]);
export type AnyResolvedSkillLoadout = z.infer<typeof AnyResolvedSkillLoadoutSchema>;

/** A sealed snapshot must resolve exactly the configuration revision and catalog it stores. */
function refineResolvedConfiguration(
  snapshot: {
    configuration: { id: string; version: number; catalog: RevisionRef };
    resolved: { configurationId: string; configurationVersion: number; catalog: RevisionRef };
  },
  context: z.RefinementCtx,
) {
  if (
    snapshot.configuration.id !== snapshot.resolved.configurationId ||
    snapshot.configuration.version !== snapshot.resolved.configurationVersion
  )
    context.addIssue({ code: 'custom', message: 'Resolved loadout configuration mismatch' });
  if (canonicalJson(snapshot.configuration.catalog) !== canonicalJson(snapshot.resolved.catalog))
    context.addIssue({ code: 'custom', message: 'Resolved loadout catalog mismatch' });
}

export const SkillLoadoutRevisionContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    revision: z.number().int().min(1).max(1_000_000),
    character: RefSchema,
    configuration: SkillConfigurationSchema,
    resolved: ResolvedSkillLoadoutSchema,
  })
  .superRefine(refineResolvedConfiguration);
export const SkillLoadoutRevisionSchema = SkillLoadoutRevisionContentSchema.safeExtend({
  contentHash: HashSchema,
});
export type SkillLoadoutRevisionContent = z.infer<typeof SkillLoadoutRevisionContentSchema>;
export type SkillLoadoutRevision = z.infer<typeof SkillLoadoutRevisionSchema>;

export const SkillLoadoutRevisionContentV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    id: IdSchema,
    revision: z.number().int().min(1).max(1_000_000),
    character: RefSchema,
    configuration: SkillConfigurationV2Schema,
    resolved: ResolvedSkillLoadoutV2Schema,
  })
  .superRefine((snapshot, context) => {
    refineResolvedConfiguration(snapshot, context);
    if (
      canonicalJson(snapshot.configuration.acquisition) !==
      canonicalJson(snapshot.resolved.acquisition)
    )
      context.addIssue({ code: 'custom', message: 'Resolved loadout acquisition mismatch' });
  });
export const SkillLoadoutRevisionV2Schema = SkillLoadoutRevisionContentV2Schema.safeExtend({
  contentHash: HashSchema,
});
export type SkillLoadoutRevisionContentV2 = z.infer<typeof SkillLoadoutRevisionContentV2Schema>;
export type SkillLoadoutRevisionV2 = z.infer<typeof SkillLoadoutRevisionV2Schema>;
export const AnySkillLoadoutRevisionContentSchema = z.union([
  SkillLoadoutRevisionContentSchema,
  SkillLoadoutRevisionContentV2Schema,
]);
export const AnySkillLoadoutRevisionSchema = z.union([
  SkillLoadoutRevisionSchema,
  SkillLoadoutRevisionV2Schema,
]);
export type AnySkillLoadoutRevisionContent = z.infer<typeof AnySkillLoadoutRevisionContentSchema>;
export type AnySkillLoadoutRevision = z.infer<typeof AnySkillLoadoutRevisionSchema>;

export const skillLoadoutRevisionHash = (snapshot: AnySkillLoadoutRevisionContent) =>
  contentHash(JSON.parse(canonicalJson(AnySkillLoadoutRevisionContentSchema.parse(snapshot))));

/** Project an immutable resolved loadout into a bounded, versioned battle receipt. */
export async function skillBattleReceipt(input: unknown): Promise<SkillLoadoutReceipt> {
  const snapshot = AnySkillLoadoutRevisionSchema.parse(input),
    { contentHash: storedHash, ...content } = snapshot;
  if (storedHash !== (await skillLoadoutRevisionHash(content)))
    throw new SkillLoadoutError('catalog-mismatch', 'Skill loadout revision hash mismatch');
  const producedIds = new Set<string>();
  let sharedProducedAbility = false,
    nonActiveAbility = false;
  for (const { resolution } of snapshot.resolved.nodeResolutions)
    for (const item of resolution) {
      nonActiveAbility ||= item.kind !== 'active-ability';
      const id = item.kind === 'augment' ? item.resolvedAbility.id : item.ability.id;
      if (producedIds.has(id)) sharedProducedAbility = true;
      producedIds.add(id);
    }
  const schemaVersion = sharedProducedAbility ? 3 : nonActiveAbility ? 2 : 1;
  return SkillLoadoutReceiptSchema.parse({
    schemaVersion,
    resolverVersion: snapshot.resolved.resolverVersion,
    character: snapshot.character,
    catalog: snapshot.resolved.catalog,
    loadout: { id: snapshot.id, revision: snapshot.revision, contentHash: storedHash },
    explicitlyEnabledNodeIds: [...snapshot.resolved.explicitlyEnabledNodeIds].sort(compareIds),
    resolvedNodeIds: [...snapshot.resolved.resolvedNodeIds].sort(compareIds),
    nodeResolutions: snapshot.resolved.nodeResolutions
      .map(({ nodeId, resolution }) => ({ nodeId, resolution }))
      .sort((a, b) => compareIds(a.nodeId, b.nodeId)),
    resolutionDigest: snapshot.resolved.resolutionDigest,
  });
}

export type SkillLoadoutCode =
  | 'catalog-mismatch'
  | 'unknown-node'
  | 'not-eligible'
  | 'unmet-learning-prerequisite'
  | 'enabled-node-not-learned'
  | 'unavailable-node'
  | 'weapon-requirement'
  | 'enabled-path-limit'
  | 'active-node-limit'
  | 'passive-node-limit'
  | 'mixed-resolution-kind';

export class SkillLoadoutError extends Error {
  readonly code: SkillLoadoutCode;
  constructor(code: SkillLoadoutCode, message: string) {
    super(message);
    this.name = 'SkillLoadoutError';
    this.code = code;
  }
}

function catalogNodes(catalog: SkillCatalog) {
  return new Map(catalog.nodes.map((node) => [node.id, node]));
}

function requireKnownIds(nodes: Map<string, SkillNode>, field: string, ids: string[]) {
  for (const id of ids)
    if (!nodes.has(id))
      throw new SkillLoadoutError('unknown-node', `${field} contains unknown skill node: ${id}`);
}

/** Derive the six UI states without mutating or silently repairing a configuration. */
export function skillNodeStates(
  catalogInput: SkillCatalog,
  configurationInput: SkillConfiguration,
): SkillNodeState[] {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    configuration = SkillConfigurationSchema.parse(configurationInput),
    nodes = catalogNodes(catalog),
    eligible = new Set(configuration.eligibilityNodeIds),
    learned = new Set(configuration.learnedNodeIds),
    enabled = new Set(configuration.enabledNodeIds);
  requireKnownIds(nodes, 'eligibilityNodeIds', configuration.eligibilityNodeIds);
  requireKnownIds(nodes, 'learnedNodeIds', configuration.learnedNodeIds);
  requireKnownIds(nodes, 'enabledNodeIds', configuration.enabledNodeIds);
  return catalog.nodes.map((node) => {
    const decision = skillNodeDecision(node, { eligible, learned, enabled });
    return {
      nodeId: node.id,
      status: decision.status,
      // Retain the historical public state's string encoding at this compatibility boundary.
      reasons: decision.reasons.map((reason) =>
        reason.code === 'unavailable-node'
          ? reason.lifecycle === 'retired'
            ? 'node-retired'
            : 'node-not-available'
          : reason.code === 'unmet-learning-prerequisite'
            ? `missing-prerequisite:${reason.prerequisiteNodeId}`
            : reason.code,
      ),
    };
  });
}

/** Resolve a configuration into deterministic, revision-bound battle input. */
export async function resolveSkillLoadout(
  catalogInput: SkillCatalog,
  configurationInput: SkillConfiguration,
  equippedWeaponTagsInput: string[],
): Promise<ResolvedSkillLoadout>;
export async function resolveSkillLoadout(
  catalogInput: SkillCatalog,
  configurationInput: SkillConfigurationV2,
  equippedWeaponTagsInput: string[],
  acquisitionInput: SkillAcquisitionRevision,
): Promise<ResolvedSkillLoadoutV2>;
export async function resolveSkillLoadout(
  catalogInput: SkillCatalog,
  configurationInput: AnySkillConfiguration,
  equippedWeaponTagsInput: string[],
  acquisitionInput?: SkillAcquisitionRevision,
): Promise<AnyResolvedSkillLoadout> {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    configuration = AnySkillConfigurationSchema.parse(configurationInput),
    equippedWeaponTags = [...new Set(equippedWeaponTagsInput.map((tag) => IdSchema.parse(tag)))],
    expectedCatalogHash = await skillCatalogDigest(catalog);
  if (
    configuration.catalog.id !== catalog.id ||
    configuration.catalog.revision !== catalog.revision ||
    configuration.catalog.contentHash !== expectedCatalogHash
  )
    throw new SkillLoadoutError('catalog-mismatch', 'Configuration catalog ref does not match');

  let eligibilityNodeIds: string[], learnedNodeIds: string[];
  let acquisition: SkillAcquisitionRevision | undefined;
  if (configuration.schemaVersion === 1) {
    eligibilityNodeIds = configuration.eligibilityNodeIds;
    learnedNodeIds = configuration.learnedNodeIds;
  } else {
    acquisition = SkillAcquisitionRevisionSchema.parse(acquisitionInput);
    const { contentHash: acquisitionHash, ...acquisitionContent } = acquisition;
    if (
      acquisitionHash !== (await skillAcquisitionRevisionHash(acquisitionContent)) ||
      canonicalJson(configuration.acquisition) !==
        canonicalJson({
          id: acquisition.id,
          revision: acquisition.revision,
          contentHash: acquisition.contentHash,
        }) ||
      canonicalJson(configuration.catalog) !== canonicalJson(acquisition.catalog)
    )
      throw new SkillLoadoutError(
        'catalog-mismatch',
        'Configuration acquisition ref does not match immutable acquisition state',
      );
    eligibilityNodeIds = acquisition.eligibilityNodeIds;
    learnedNodeIds = acquisition.learnedNodeIds;
  }

  const nodes = catalogNodes(catalog),
    eligible = new Set(eligibilityNodeIds),
    learned = new Set(learnedNodeIds);
  requireKnownIds(nodes, 'eligibilityNodeIds', eligibilityNodeIds);
  requireKnownIds(nodes, 'learnedNodeIds', learnedNodeIds);
  requireKnownIds(nodes, 'enabledNodeIds', configuration.enabledNodeIds);
  for (const id of learned) {
    const node = nodes.get(id)!;
    const reason = skillLearningReasons(node, { eligible, learned })[0];
    if (reason?.code === 'not-eligible')
      throw new SkillLoadoutError(reason.code, `Learned node is not eligible: ${id}`);
    if (reason?.code === 'unmet-learning-prerequisite')
      throw new SkillLoadoutError(
        reason.code,
        `Learned node ${id} requires ${reason.prerequisiteNodeId}`,
      );
  }
  const unlearnedEnabled = skillEnabledLearningReasons(configuration.enabledNodeIds, learned)[0];
  if (unlearnedEnabled)
    throw new SkillLoadoutError(
      unlearnedEnabled.code,
      `Enabled node is not learned: ${unlearnedEnabled.nodeId}`,
    );

  const resolvedNodeIds = skillPrerequisiteClosure(catalog.nodes, configuration.enabledNodeIds),
    resolvedNodes = resolvedNodeIds.map((id) => nodes.get(id)!);
  for (const node of resolvedNodes) {
    const reason = skillEquipmentReasons(node, new Set(equippedWeaponTags))[0];
    if (reason?.code === 'unavailable-node')
      throw new SkillLoadoutError(
        reason.code,
        `Enabled closure contains unavailable node: ${node.id}`,
      );
    if (reason?.code === 'weapon-requirement')
      throw new SkillLoadoutError(
        reason.code,
        `Skill node ${node.id} requires equipped weapon tag ${reason.weaponTag}`,
      );
  }
  const reason = inspectSkillEnabledNodes(resolvedNodes).reasons[0];
  if (reason?.code === 'enabled-path-limit')
    throw new SkillLoadoutError(
      reason.code,
      `Resolved loadout uses ${reason.count} paths; maximum is ${reason.maximum}`,
    );
  if (reason?.code === 'mixed-resolution-kind')
    throw new SkillLoadoutError(
      reason.code,
      `Skill node mixes active and passive/augment recipes: ${reason.nodeId}`,
    );
  if (reason?.code === 'active-node-limit' || reason?.code === 'passive-node-limit')
    throw new SkillLoadoutError(
      reason.code,
      `Resolved loadout uses ${reason.count} ${reason.code === 'active-node-limit' ? 'active' : 'passive/augment'} nodes; maximum is ${reason.maximum}`,
    );

  const digestInput = {
    resolverVersion: SKILL_RESOLVER_VERSION,
    catalog: configuration.catalog,
    resolvedNodeIds,
    nodeResolutions: resolvedNodes.map((node) => ({
      nodeId: node.id,
      resolution: node.resolution,
    })),
  };
  const common = {
    resolverVersion: SKILL_RESOLVER_VERSION,
    configurationId: configuration.id,
    configurationVersion: configuration.version,
    catalog: configuration.catalog,
    learnedNodeIds: [...learned].sort(compareIds),
    explicitlyEnabledNodeIds: [...configuration.enabledNodeIds].sort(compareIds),
    resolvedNodeIds,
    nodeResolutions: digestInput.nodeResolutions,
    resolutionDigest: await contentHash(JSON.parse(canonicalJson(digestInput))),
  };
  return configuration.schemaVersion === 1
    ? { schemaVersion: 1, ...common }
    : { schemaVersion: 2, ...common, acquisition: configuration.acquisition };
}
