import { z } from 'zod';
import { canonicalJson, compareIds, contentHash } from './spatial/canonical.ts';
import { HashSchema, IdSchema, RefSchema, type RevisionRef } from './spatial/contracts.ts';
import {
  type SkillCatalog,
  type SkillNode,
  parseCompleteSkillCatalog,
  skillCatalogDigest,
} from './skill-system.ts';

const UniqueNodeIdsSchema = z
  .array(IdSchema)
  .max(1_152)
  .refine((ids) => new Set(ids).size === ids.length, 'Skill node IDs must be unique');
export const SKILL_ACQUISITION_POLICY_VERSION = 'skill-acquisition-v1' as const;

export const SkillAcquisitionSelectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: IdSchema,
  version: z.number().int().min(1).max(1_000_000),
  character: RefSchema,
  catalog: RefSchema,
  learnedNodeIds: UniqueNodeIdsSchema,
});
export type SkillAcquisitionSelection = z.infer<typeof SkillAcquisitionSelectionSchema>;

export const SkillAcquisitionCapabilitiesSchema = z
  .strictObject({
    equipmentTags: z.array(IdSchema).max(64),
    abilityRefs: z.array(RefSchema).max(256),
  })
  .superRefine((capabilities, context) => {
    if (new Set(capabilities.equipmentTags).size !== capabilities.equipmentTags.length)
      context.addIssue({ code: 'custom', message: 'Equipment tags must be unique' });
    const refs = capabilities.abilityRefs.map(revisionRefKey);
    if (new Set(refs).size !== refs.length)
      context.addIssue({ code: 'custom', message: 'Ability refs must be unique' });
  });
export type SkillAcquisitionCapabilities = z.infer<typeof SkillAcquisitionCapabilitiesSchema>;

export const SkillAcquisitionRevisionContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(SKILL_ACQUISITION_POLICY_VERSION),
  id: IdSchema,
  revision: z.number().int().min(1).max(1_000_000),
  character: RefSchema,
  catalog: RefSchema,
  eligibilityNodeIds: UniqueNodeIdsSchema,
  learnedNodeIds: UniqueNodeIdsSchema,
  capabilitiesDigest: HashSchema,
});
export const SkillAcquisitionRevisionSchema = SkillAcquisitionRevisionContentSchema.extend({
  contentHash: HashSchema,
});
export type SkillAcquisitionRevisionContent = z.infer<typeof SkillAcquisitionRevisionContentSchema>;
export type SkillAcquisitionRevision = z.infer<typeof SkillAcquisitionRevisionSchema>;

export type SkillBranchDan = { path: string; zodiac: string; dan: number };

export type SkillAcquisitionCode =
  | 'catalog-mismatch'
  | 'unknown-node'
  | 'not-eligible'
  | 'unmet-learning-prerequisite';

export class SkillAcquisitionError extends Error {
  readonly code: SkillAcquisitionCode;
  constructor(code: SkillAcquisitionCode, message: string) {
    super(message);
    this.name = 'SkillAcquisitionError';
    this.code = code;
  }
}

const revisionRefKey = (ref: RevisionRef) => `${ref.id}@${ref.revision}:${ref.contentHash}`;

function canonicalCapabilities(input: SkillAcquisitionCapabilities) {
  const parsed = SkillAcquisitionCapabilitiesSchema.parse(input);
  return {
    equipmentTags: [...parsed.equipmentTags].sort(compareIds),
    abilityRefs: [...parsed.abilityRefs].sort((left, right) =>
      revisionRefKey(left).localeCompare(revisionRefKey(right), 'en'),
    ),
  };
}

function nodeIsApplicable(node: SkillNode, equipmentTags: Set<string>, abilityRefs: Set<string>) {
  if (node.lifecycle !== 'available' || !node.resolution.length) return false;
  if (node.weaponTags?.some((tag) => !equipmentTags.has(tag))) return false;
  return node.resolution.every(
    (resolution) =>
      resolution.kind !== 'augment' || abilityRefs.has(revisionRefKey(resolution.baseAbility)),
  );
}

/** Derive eligibility only from immutable catalog and server-resolved character capabilities. */
export async function deriveSkillEligibility(
  catalogInput: SkillCatalog,
  capabilitiesInput: SkillAcquisitionCapabilities,
) {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    capabilities = canonicalCapabilities(capabilitiesInput),
    equipmentTags = new Set(capabilities.equipmentTags),
    abilityRefs = new Set(capabilities.abilityRefs.map(revisionRefKey));
  return {
    eligibilityNodeIds: catalog.nodes
      .filter((node) => nodeIsApplicable(node, equipmentTags, abilityRefs))
      .map(({ id }) => id)
      .sort(compareIds),
    capabilitiesDigest: await contentHash(JSON.parse(canonicalJson(capabilities))),
  };
}

/** Seal one explicit, free learning/respec choice as an immutable acquisition revision. */
export async function resolveSkillAcquisitionV1(
  catalogInput: SkillCatalog,
  selectionInput: SkillAcquisitionSelection,
  capabilitiesInput: SkillAcquisitionCapabilities,
): Promise<SkillAcquisitionRevisionContent> {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    selection = SkillAcquisitionSelectionSchema.parse(selectionInput),
    catalogHash = await skillCatalogDigest(catalog);
  if (
    selection.catalog.id !== catalog.id ||
    selection.catalog.revision !== catalog.revision ||
    selection.catalog.contentHash !== catalogHash
  )
    throw new SkillAcquisitionError('catalog-mismatch', 'Acquisition catalog ref does not match');
  const { eligibilityNodeIds, capabilitiesDigest } = await deriveSkillEligibility(
      catalog,
      capabilitiesInput,
    ),
    nodes = new Map(catalog.nodes.map((node) => [node.id, node])),
    eligible = new Set(eligibilityNodeIds),
    learned = new Set(selection.learnedNodeIds);
  for (const id of learned) {
    const node = nodes.get(id);
    if (!node) throw new SkillAcquisitionError('unknown-node', `Unknown learned node: ${id}`);
    if (!eligible.has(id))
      throw new SkillAcquisitionError('not-eligible', `Learned node is not eligible: ${id}`);
    const missing = node.prerequisites.find((prerequisite) => !learned.has(prerequisite));
    if (missing)
      throw new SkillAcquisitionError(
        'unmet-learning-prerequisite',
        `Learned node ${id} requires ${missing}`,
      );
  }
  return {
    schemaVersion: 1,
    policyVersion: SKILL_ACQUISITION_POLICY_VERSION,
    id: selection.id,
    revision: selection.version,
    character: selection.character,
    catalog: selection.catalog,
    eligibilityNodeIds,
    learnedNodeIds: [...learned].sort(compareIds),
    capabilitiesDigest,
  };
}

export const resolveSkillAcquisition = resolveSkillAcquisitionV1;

export const skillAcquisitionRevisionHash = (content: SkillAcquisitionRevisionContent) =>
  contentHash(JSON.parse(canonicalJson(SkillAcquisitionRevisionContentSchema.parse(content))));

/** Dan is derived per path/zodiac branch and is never an independent mutable counter. */
export function skillBranchDans(catalogInput: SkillCatalog, learnedNodeIds: string[]) {
  const catalog = parseCompleteSkillCatalog(catalogInput),
    learned = new Set(UniqueNodeIdsSchema.parse(learnedNodeIds)),
    branches = new Map<string, SkillBranchDan>();
  for (const node of catalog.nodes) {
    if (!learned.has(node.id)) continue;
    const key = `${node.coordinate.path}:${node.coordinate.zodiac}`,
      current = branches.get(key);
    if (!current || node.coordinate.dan > current.dan) branches.set(key, { ...node.coordinate });
  }
  return [...branches.values()].sort((left, right) =>
    `${left.path}:${left.zodiac}`.localeCompare(`${right.path}:${right.zodiac}`, 'en'),
  );
}
