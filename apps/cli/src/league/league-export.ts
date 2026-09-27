import {
  OperationError,
  withReplayVerificationPool,
  type ReplayVerificationPool,
} from '@fantasy/api/artifacts';
import {
  PublicLeagueDetailSchema,
  PublicLeagueSnapshotSchema,
  PublicLeagueSlotPageSchema,
  compareIds,
  leagueDefinitionClass,
  type LeaguePlan,
  type LeagueFileRef,
  type PublicLeagueSlotPage,
  type PublicLeagueDetail,
  type PublicCatalog,
} from '@fantasy/domain/spatial';
import { checkStoredLeague, type checkLeague, type LeagueCheckInput } from '@fantasy/api/tooling';
import { buildPublication } from '../publication/publication-export.ts';
import { commitPublication } from '../publication/publication-catalog.ts';
import { publicationJson, type PublicationFile } from '../publication/publication-files.ts';

type LeagueWorkPublication = {
  ref: NonNullable<PublicCatalog['leagueWork']>;
  files: PublicationFile[];
};
type LeagueWorkBuilder =
  | LeagueWorkPublication
  | ((checked: Awaited<ReturnType<typeof checkLeague>>) => Promise<LeagueWorkPublication>);

export function leagueFile(value: unknown) {
  const file = publicationJson(`leagues/${'0'.repeat(64)}.json`, value);
  file.key = `leagues/${file.checksum.slice(7)}.json`;
  return { file, ref: { hash: file.checksum, bytes: file.bytes } satisfies LeagueFileRef };
}

/** Every partition is supplied, even when its calculation artifact is absent. */
export async function exportLeague(
  input: unknown,
  partitions: readonly { partition: unknown; batch: unknown }[],
  completed: readonly LeagueCheckInput[],
  directory: string,
  work?: LeagueWorkBuilder,
  options: { verificationWorkers?: number; signal?: AbortSignal } = {},
) {
  return withReplayVerificationPool(
    options.verificationWorkers ?? 1,
    (pool) => buildLeaguePublication(input, partitions, completed, directory, work, pool, options.signal),
    options.signal,
  );
}

async function buildLeaguePublication(
  input: unknown,
  partitions: readonly { partition: unknown; batch: unknown }[],
  completed: readonly LeagueCheckInput[],
  directory: string,
  work: LeagueWorkBuilder | undefined,
  pool: ReplayVerificationPool | undefined,
  signal: AbortSignal | undefined,
) {
  const checked = await checkStoredLeague(input, partitions, completed, pool),
    { plan, standings } = checked;
  const journal = typeof work === 'function' ? await work(checked) : work;
  signal?.throwIfAborted();
  const latestOutcomes = new Map(
    checked.attempts.map((attempt) => [attempt.slotId, attempt.outcome.kind] as const),
  );
  const files = new Map<string, PublicationFile>();
  const add = (file: PublicationFile) => {
    const prior = files.get(file.key);
    if (prior && (prior.checksum !== file.checksum || prior.bytes !== file.bytes))
      throw new OperationError('DATA_INVALID', 'Conflicting league publication bytes');
    files.set(file.key, file);
  };
  const addJson = (value: unknown) => {
    const { file, ref } = leagueFile(value);
    add(file);
    return ref;
  };
  const sets: PublicCatalog['sets'] = [];
  const pairs = new Map<string, PublicLeagueSlotPage['rows']>();
  const results = new Map(checked.results.map((result) => [result.index.planId, result]));
  for (const { partition, batch } of checked.partitions.values()) {
    signal?.throwIfAborted();
    const result = results.get(batch.id);
    const source = result ? checked.resultSources.get(result.id) : undefined;
    if (result && !source) throw new OperationError('DATA_INVALID', 'Missing verified result source');
    const built = await buildPublication(
      batch,
      source ? [{ index: result!.index, bundles: source.bundles }] : [],
      directory,
      pool,
    );
    built.files.forEach(add);
    sets.push(built.setRef);
    const batchSlots = new Map(batch.slots.map((slot) => [slot.key, slot]));
    const rowIndexes = new Map(built.rows.map((row, index) => [row.slotId, index]));
    for (const slot of partition.slots) {
      const batchSlot = batchSlots.get(slot.id.slice(7))!;
      const rowIndex = rowIndexes.get(batchSlot.id);
      if (rowIndex === undefined) throw new OperationError('DATA_INVALID', 'Missing public league row');
      const key = slot.characters.map((c) => c.id).join('/');
      const rows = pairs.get(key) ?? [];
      rows.push({
        slot,
        setHash: built.setHash,
        pageHash: built.set.pages[Math.floor(rowIndex / 100)]!.pageHash,
        rowId: batchSlot.id,
        ...(latestOutcomes.get(slot.id) === 'cancelled' ? { cancelled: true as const } : {}),
      });
      pairs.set(key, rows);
    }
  }
  const pairPages = new Map<string, PublicLeagueDetail['opponents'][number]['pages']>();
  for (const [key, rows] of pairs) {
    rows.sort((a, b) => compareIds(a.slot.id, b.slot.id));
    const pages: PublicLeagueDetail['opponents'][number]['pages'] = [];
    for (let offset = 0; offset < rows.length; offset += 100) {
      const page = PublicLeagueSlotPageSchema.parse({
        schemaVersion: 1,
        leagueHash: plan.revision.leagueHash,
        characters: rows[0]!.slot.characters.map((c) => c.id),
        index: pages.length,
        rows: rows.slice(offset, offset + 100),
      });
      pages.push({ ...addJson(page), rows: page.rows.length });
    }
    pairPages.set(key, pages);
  }
  const rows = standings.rows.map((standing) => {
    const detail = PublicLeagueDetailSchema.parse({
      schemaVersion: 1,
      leagueHash: plan.revision.leagueHash,
      standing,
      opponents: standing.opponents.map(({ character }) => ({
        character,
        pages: pairPages.get([standing.character, character].sort(compareIds).join('/'))!,
      })),
    });
    const { scenarios: _, opponents: __, ...summary } = standing;
    return { ...summary, detail: addJson(detail) };
  });
  const { definition, ...identity } = plan.revision;
  const classification =
    leagueDefinitionClass(definition) === 'experimental'
      ? { leagueClass: 'experimental' as const }
      : {};
  const snapshot = PublicLeagueSnapshotSchema.parse({
    ...identity,
    ...classification,
    id: definition.id,
    name: definition.name,
    trials: definition.trials,
    masterSeed: definition.masterSeed,
    definition: addJson(plan.revision),
    characters: definition.characters.map((ref) => named(plan, 'character', ref.id)),
    battlefields: definition.battlefields.map((field) => ({
      scenario: named(plan, 'scenario', field.scenario.id),
      weight: field.weight,
    })),
    standings: { ...standings, rows },
  });
  const ref = addJson(snapshot);
  journal?.files.forEach(add);
  const written = await commitPublication(directory, [...files.values()], sets, {
    league: {
      ...ref,
      ...classification,
      id: snapshot.id,
      leagueHash: snapshot.leagueHash,
      inputHash: snapshot.inputHash,
    },
    ...(journal ? { leagueWork: journal.ref } : {}),
    ...(signal ? { signal } : {}),
  });
  return {
    ...written,
    snapshot: ref,
    status: standings.status,
    planned: standings.planned,
    resolved: standings.resolved,
    missingPartitions: checked.missingPartitions,
  };
}
function named(plan: LeaguePlan, kind: 'character' | 'scenario', id: string) {
  const revision = plan.revision.definition.revisions.find((r) => r.kind === kind && r.id === id)!;
  return {
    id,
    revision: revision.revision,
    contentHash: revision.contentHash,
    name: revision.definition.name,
  };
}
