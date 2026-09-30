import { z } from 'zod';
import { canonicalJson, compareIds, contentHash } from './spatial/canonical.ts';
import {
  HashSchema,
  IdSchema,
  RefSchema,
  SkillLoadoutReceiptSchema,
  type SkillLoadoutReceipt,
} from './spatial/contracts.ts';
import {
  SkillResolutionSchema,
  type SkillCatalog,
  type SkillNode,
  parseCompleteSkillCatalog,
  skillCatalogDigest,
} from './skill-system.ts';

export const SKILL_RESOLVER_VERSION = 'skill-resolver-v1' as const;
export const MAX_ENABLED_SKILL_PATHS = 2;
export const MAX_ACTIVE_SKILL_NODES = 8;
export const MAX_PASSIVE_SKILL_NODES = 4;

const UniqueNodeIdsSchema = (maximum: number) =>
  z
    .array(IdSchema)
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, 'Skill node IDs must be unique');

export const SkillConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  version: z.number().int().min(1).max(1_000_000),
  catalog: RefSchema,
  eligibilityNodeIds: UniqueNodeIdsSchema(1_152),
  learnedNodeIds: UniqueNodeIdsSchema(1_152),
  enabledNodeIds: UniqueNodeIdsSchema(12),
});
export type SkillConfiguration = z.infer<typeof SkillConfigurationSchema>;

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

export const ResolvedSkillLoadoutSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resolverVersion: z.literal(SKILL_RESOLVER_VERSION),
  configurationId: IdSchema,
  configurationVersion: z.number().int().min(1).max(1_000_000),
  catalog: RefSchema,
  learnedNodeIds: UniqueNodeIdsSchema(1_152),
  explicitlyEnabledNodeIds: UniqueNodeIdsSchema(12),
  resolvedNodeIds: UniqueNodeIdsSchema(12),
  nodeResolutions: z
    .array(
      z.strictObject({
        nodeId: IdSchema,
        resolution: z.array(SkillResolutionSchema).min(1).max(8),
      }),
    )
    .max(12),
  resolutionDigest: HashSchema,
});
export type ResolvedSkillLoadout = z.infer<typeof ResolvedSkillLoadoutSchema>;

export const SkillLoadoutRevisionContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    revision: z.number().int().min(1).max(1_000_000),
    character: RefSchema,
    configuration: SkillConfigurationSchema,
    resolved: ResolvedSkillLoadoutSchema,
  })
  .superRefine((snapshot, context) => {
    if (
      snapshot.configuration.id !== snapshot.resolved.configurationId ||
      snapshot.configuration.version !== snapshot.resolved.configurationVersion
    )
      context.addIssue({ code: 'custom', message: 'Resolved loadout configuration mismatch' });
    if (canonicalJson(snapshot.configuration.catalog) !== canonicalJson(snapshot.resolved.catalog))
      context.addIssue({ code: 'custom', message: 'Resolved loadout catalog mismatch' });
  });
export const SkillLoadoutRevisionSchema = SkillLoadoutRevisionContentSchema.safeExtend({
  contentHash: HashSchema,
});
export type SkillLoadoutRevisionContent = z.infer<typeof SkillLoadoutRevisionContentSchema>;
export type SkillLoadoutRevision = z.infer<typeof SkillLoadoutRevisionSchema>;

export const skillLoadoutRevisionHash = (snapshot: SkillLoadoutRevisionContent) =>
  contentHash(JSON.parse(canonicalJson(SkillLoadoutRevisionContentSchema.parse(snapshot))));

/** Project an immutable resolved loadout into the bounded active-only SK-02 battle receipt. */
export async function skillBattleReceipt(input: unknown): Promise<SkillLoadoutReceipt> {
  const snapshot = SkillLoadoutRevisionSchema.parse(input),
    { contentHash: storedHash, ...content } = snapshot;
  if (storedHash !== (await skillLoadoutRevisionHash(content)))
    throw new SkillLoadoutError('catalog-mismatch', 'Skill loadout revision hash mismatch');
  if (
    snapshot.resolved.nodeResolutions.some(({ resolution }) =>
      resolution.some(({ kind }) => kind !== 'active-ability'),
    )
  )
    throw new SkillLoadoutError(
      'unavailable-node',
      'SK-02 battle receipts support active abilities only',
    );
  return SkillLoadoutReceiptSchema.parse({
    schemaVersion: 1,
    resolverVersion: snapshot.resolved.resolverVersion,
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
    if (node.lifecycle === 'retired')
      return { nodeId: node.id, status: 'retired', reasons: ['node-retired'] };
    if (node.lifecycle !== 'available')
      return { nodeId: node.id, status: 'unsupported', reasons: ['node-not-available'] };
    if (enabled.has(node.id)) return { nodeId: node.id, status: 'enabled', reasons: [] };
    if (learned.has(node.id)) return { nodeId: node.id, status: 'learned', reasons: [] };
    const reasons = [
      ...(!eligible.has(node.id) ? ['not-eligible'] : []),
      ...node.prerequisites
        .filter((id) => !learned.has(id))
        .map((id) => `missing-prerequisite:${id}`),
    ];
    return {
      nodeId: node.id,
      status: reasons.length ? 'locked' : 'learnable',
      reasons,
    };
  });
}

function closeEnabledNodes(nodes: Map<string, SkillNode>, enabledIds: string[]) {
  const closed = new Set<string>();
  const add = (id: string) => {
    if (closed.has(id)) return;
    const node = nodes.get(id)!;
    node.prerequisites.forEach(add);
    closed.add(id);
  };
  enabledIds.forEach(add);
  return [...closed].sort(compareIds);
}

function nodeKind(node: SkillNode): 'active' | 'passive' {
  const active = node.resolution.some(({ kind }) => kind === 'active-ability'),
    passive = node.resolution.some(({ kind }) => kind !== 'active-ability');
  if (active && passive)
    throw new SkillLoadoutError(
      'mixed-resolution-kind',
      `Skill node mixes active and passive/augment recipes: ${node.id}`,
    );
  return active ? 'active' : 'passive';
}

/** Resolve a configuration into deterministic, revision-bound battle input. */
export async function resolveSkillLoadout(
  catalogInput: SkillCatalog,
  configurationInput: SkillConfiguration,
  equippedWeaponTagsInput: string[],
): Promise<ResolvedSkillLoadout> {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    configuration = SkillConfigurationSchema.parse(configurationInput),
    equippedWeaponTags = [...new Set(equippedWeaponTagsInput.map((tag) => IdSchema.parse(tag)))],
    expectedCatalogHash = await skillCatalogDigest(catalog);
  if (
    configuration.catalog.id !== catalog.id ||
    configuration.catalog.revision !== catalog.revision ||
    configuration.catalog.contentHash !== expectedCatalogHash
  )
    throw new SkillLoadoutError('catalog-mismatch', 'Configuration catalog ref does not match');

  const nodes = catalogNodes(catalog),
    eligible = new Set(configuration.eligibilityNodeIds),
    learned = new Set(configuration.learnedNodeIds);
  requireKnownIds(nodes, 'eligibilityNodeIds', configuration.eligibilityNodeIds);
  requireKnownIds(nodes, 'learnedNodeIds', configuration.learnedNodeIds);
  requireKnownIds(nodes, 'enabledNodeIds', configuration.enabledNodeIds);
  for (const id of learned) {
    const node = nodes.get(id)!;
    if (!eligible.has(id))
      throw new SkillLoadoutError('not-eligible', `Learned node is not eligible: ${id}`);
    const missing = node.prerequisites.find((prerequisite) => !learned.has(prerequisite));
    if (missing)
      throw new SkillLoadoutError(
        'unmet-learning-prerequisite',
        `Learned node ${id} requires ${missing}`,
      );
  }
  for (const id of configuration.enabledNodeIds)
    if (!learned.has(id))
      throw new SkillLoadoutError('enabled-node-not-learned', `Enabled node is not learned: ${id}`);

  const resolvedNodeIds = closeEnabledNodes(nodes, configuration.enabledNodeIds),
    resolvedNodes = resolvedNodeIds.map((id) => nodes.get(id)!);
  for (const node of resolvedNodes) {
    if (node.lifecycle !== 'available' || !node.resolution.length)
      throw new SkillLoadoutError(
        'unavailable-node',
        `Enabled closure contains unavailable node: ${node.id}`,
      );
    const missingTag = node.weaponTags?.find((tag) => !equippedWeaponTags.includes(tag));
    if (missingTag)
      throw new SkillLoadoutError(
        'weapon-requirement',
        `Skill node ${node.id} requires equipped weapon tag ${missingTag}`,
      );
  }
  const paths = new Set(resolvedNodes.map((node) => node.coordinate.path));
  if (paths.size > MAX_ENABLED_SKILL_PATHS)
    throw new SkillLoadoutError(
      'enabled-path-limit',
      `Resolved loadout uses ${paths.size} paths; maximum is ${MAX_ENABLED_SKILL_PATHS}`,
    );
  const active = resolvedNodes.filter((node) => nodeKind(node) === 'active').length,
    passive = resolvedNodes.length - active;
  if (active > MAX_ACTIVE_SKILL_NODES)
    throw new SkillLoadoutError(
      'active-node-limit',
      `Resolved loadout uses ${active} active nodes; maximum is ${MAX_ACTIVE_SKILL_NODES}`,
    );
  if (passive > MAX_PASSIVE_SKILL_NODES)
    throw new SkillLoadoutError(
      'passive-node-limit',
      `Resolved loadout uses ${passive} passive/augment nodes; maximum is ${MAX_PASSIVE_SKILL_NODES}`,
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
  return {
    schemaVersion: 1,
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
}
