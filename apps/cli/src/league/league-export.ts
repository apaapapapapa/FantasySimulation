import { OperationError } from '@fantasy/api/artifacts';
import {
  PublicLeagueDetailSchema,
  PublicLeagueSnapshotSchema,
  PublicLeagueSlotPageSchema,
  canonicalJson,
  compareIds,
  type LeaguePlan,
  type LeagueFileRef,
  type PublicLeagueSlotPage,
  type PublicLeagueDetail,
  type PublicCatalog,
} from '@fantasy/domain/spatial';
import { checkLeague, validateLeaguePartition, type LeagueCheckInput } from '@fantasy/api/tooling';
import { buildPublication } from '../publication/publication-export.ts';
import { commitPublication } from '../publication/publication-catalog.ts';
import { publicationJson, type PublicationFile } from '../publication/publication-files.ts';

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
  work?: { ref: NonNullable<PublicCatalog['leagueWork']>; files: PublicationFile[] },
) {
  const checked = await checkLeague(input, completed),
    { plan, standings } = checked;
  const latestOutcomes = new Map(
    checked.attempts.map((attempt) => [attempt.slotId, attempt.outcome.kind] as const),
  );
  if (partitions.length !== plan.partitions.length)
    throw new OperationError('DATA_INVALID', 'Missing league partition definition');
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
  const seen = new Set<number>();
  const pairs = new Map<string, PublicLeagueSlotPage['rows']>();
  for (const entry of partitions) {
    const { partition, batch } = await validateLeaguePartition(plan, entry.partition, entry.batch);
    if (seen.has(partition.index))
      throw new OperationError('DATA_INVALID', 'Duplicate league partition definition');
    seen.add(partition.index);
    const result = checked.results.find((r) => r.index.planId === batch.id);
    const source = result
      ? completed.find((c) => canonicalJson(c.result) === canonicalJson(result))
      : undefined;
    const built = await buildPublication(
      batch,
      source ? [{ index: result!.index, bundles: source.bundles }] : [],
      directory,
    );
    built.files.forEach(add);
    sets.push(built.setRef);
    for (const slot of partition.slots) {
      const batchSlot = batch.slots.find((s) => s.key === slot.id.slice(7))!;
      const rowIndex = built.rows.findIndex((row) => row.slotId === batchSlot.id);
      if (rowIndex < 0) throw new OperationError('DATA_INVALID', 'Missing public league row');
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
  const snapshot = PublicLeagueSnapshotSchema.parse({
    ...identity,
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
  work?.files.forEach(add);
  const written = await commitPublication(directory, [...files.values()], sets, {
    league: {
      ...ref,
      id: snapshot.id,
      leagueHash: snapshot.leagueHash,
      inputHash: snapshot.inputHash,
    },
    ...(work ? { leagueWork: work.ref } : {}),
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
