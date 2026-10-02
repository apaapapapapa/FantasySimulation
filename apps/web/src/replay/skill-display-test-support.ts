import {
  SkillLoadoutReceiptSchema,
  canonicalJson,
  contentHash,
  type RevisionRef,
} from '@fantasy/domain/spatial';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

export async function skillReceipt(input: {
  character: RevisionRef;
  catalogRevision: number;
  loadoutId: string;
  nodeId: string;
  ability: RevisionRef;
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
        resolution: [{ kind: 'active-ability' as const, ability: input.ability }],
      },
    ],
    resolutionDigest = await contentHash(
      JSON.parse(
        canonicalJson({
          resolverVersion: 'skill-resolver-v1',
          catalog,
          resolvedNodeIds,
          nodeResolutions,
        }),
      ),
    );
  return SkillLoadoutReceiptSchema.parse({
    schemaVersion: 2,
    resolverVersion: 'skill-resolver-v1',
    character: input.character,
    catalog,
    loadout,
    explicitlyEnabledNodeIds: resolvedNodeIds,
    resolvedNodeIds,
    nodeResolutions,
    resolutionDigest,
  });
}
