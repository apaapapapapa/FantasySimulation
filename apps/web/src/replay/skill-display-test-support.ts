import {
  SkillLoadoutReceiptSchema,
  canonicalJson,
  contentHash,
  type RevisionRef,
  type SkillLoadoutReceipt,
} from '@fantasy/domain/spatial';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

async function resolutionDigest(
  catalog: SkillLoadoutReceipt['catalog'],
  resolvedNodeIds: string[],
  nodeResolutions: SkillLoadoutReceipt['nodeResolutions'],
) {
  return contentHash(
    JSON.parse(
      canonicalJson({
        resolverVersion: 'skill-resolver-v1',
        catalog,
        resolvedNodeIds,
        nodeResolutions,
      }),
    ),
  );
}

export async function skillReceipt(input: {
  character: RevisionRef;
  catalogRevision: number;
  loadoutId: string;
  nodeId: string;
  ability: RevisionRef;
  kind?: 'active-ability' | 'passive-ability';
}) {
  const catalog = {
      id: 'skill-catalog-v1',
      revision: input.catalogRevision,
      contentHash: hash('1'),
    },
    loadout = { id: input.loadoutId, revision: 1, contentHash: hash('2') },
    resolvedNodeIds = [input.nodeId],
    nodeResolutions = [
      {
        nodeId: input.nodeId,
        resolution: [{ kind: input.kind ?? 'active-ability', ability: input.ability }],
      },
    ],
    digest = await resolutionDigest(catalog, resolvedNodeIds, nodeResolutions);
  return SkillLoadoutReceiptSchema.parse({
    schemaVersion: 2,
    resolverVersion: 'skill-resolver-v1',
    character: input.character,
    catalog,
    loadout,
    explicitlyEnabledNodeIds: resolvedNodeIds,
    resolvedNodeIds,
    nodeResolutions,
    resolutionDigest: digest,
  });
}

/** Build a V3 receipt whose duplicate ability grants retain every source node. */
export async function sharedSkillReceipt(input: {
  character: RevisionRef;
  catalogRevision: number;
  loadoutId: string;
  explicitlyEnabledNodeIds: string[];
  nodeResolutions: SkillLoadoutReceipt['nodeResolutions'];
}) {
  const catalog = {
      id: 'skill-catalog-v1',
      revision: input.catalogRevision,
      contentHash: hash('1'),
    },
    loadout = { id: input.loadoutId, revision: 1, contentHash: hash('2') },
    resolvedNodeIds = input.nodeResolutions.map(({ nodeId }) => nodeId),
    digest = await resolutionDigest(catalog, resolvedNodeIds, input.nodeResolutions);
  return SkillLoadoutReceiptSchema.parse({
    schemaVersion: 3,
    resolverVersion: 'skill-resolver-v1',
    character: input.character,
    catalog,
    loadout,
    explicitlyEnabledNodeIds: input.explicitlyEnabledNodeIds,
    resolvedNodeIds,
    nodeResolutions: input.nodeResolutions,
    resolutionDigest: digest,
  });
}
