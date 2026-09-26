import { OperationError } from '@fantasy/api/artifacts';
import {
  PublicLeagueSnapshotSchema,
  LeagueRevisionSchema,
  canonicalJson,
  contentHash,
  leagueSlotCount,
  type LeagueFileRef,
  type PublicCatalog,
  type RevisionRef,
  assertLeagueMetadata,
} from '@fantasy/domain/spatial';
import { normalizeStoredLeagueDefinition } from '@fantasy/engine/spatial';

export type LeagueJson = <T>(
  ref: LeagueFileRef,
  schema: { parse(value: unknown): T },
) => Promise<T>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Validate stored bytes and links without current-engine eligibility or slot expansion. */
export async function leagueMetadata(
  ref: NonNullable<PublicCatalog['leagues']>[number],
  json: LeagueJson,
) {
  const snapshot = await json(ref, PublicLeagueSnapshotSchema);
  const revision = await json(snapshot.definition, LeagueRevisionSchema);
  const { definition } = revision;
  const leagueClass = await assertLeagueMetadata(snapshot, revision, ref).catch(() => {
    throw new OperationError('DATA_INVALID', 'League snapshot definition identity mismatch');
  });
  const normalized = await normalizeStoredLeagueDefinition(definition).catch(() => {
    throw new OperationError('DATA_INVALID', 'League definition revision or closure invalid');
  });
  const named = (kind: 'character' | 'scenario', ref: RevisionRef) => {
    const { id } = ref;
    const value = definition.revisions.find(
      (r) =>
        r.kind === kind &&
        r.id === id &&
        r.revision === ref.revision &&
        r.contentHash === ref.contentHash,
    );
    if (!value) throw new OperationError('DATA_INVALID', 'League named revision missing');
    return {
      id,
      revision: value.revision,
      contentHash: value.contentHash,
      name: value.definition.name,
    };
  };
  if (
    !same(
      snapshot.characters,
      definition.characters.map((c) => named('character', c)),
    ) ||
    !same(
      snapshot.battlefields,
      definition.battlefields.map((f) => ({
        scenario: named('scenario', f.scenario),
        weight: f.weight,
      })),
    )
  )
    throw new OperationError('DATA_INVALID', 'League display metadata mismatch');
  const { standings } = snapshot;
  const planned = leagueSlotCount(definition);
  const rows = standings.rows;
  if (
    standings.planned !== planned ||
    standings.resolved > planned ||
    (standings.status === 'formal') !== (standings.resolved === planned) ||
    rows.length !== definition.characters.length ||
    new Set(rows.map((r) => r.character)).size !== rows.length ||
    rows.some(
      (r) =>
        !definition.characters.some((c) => c.id === r.character) ||
        r.overall.counts.planned !== (2 * planned) / rows.length ||
        Object.values(r.overall.counts).reduce((sum, n) => sum + n, 0) !==
          2 * r.overall.counts.planned,
    ) ||
    rows.reduce(
      (sum, r) => sum + r.overall.counts.wins + r.overall.counts.draws + r.overall.counts.losses,
      0,
    ) !==
      2 * standings.resolved
  )
    throw new OperationError('DATA_INVALID', 'League summary denominator mismatch');
  return { snapshot, revision, leagueClass, definitionHash: await contentHash(normalized) };
}
