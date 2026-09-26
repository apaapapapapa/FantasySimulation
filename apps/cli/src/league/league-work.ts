import { OperationError } from '@fantasy/api/artifacts';
import {
  PublicLeagueWorkSchema,
  canonicalJson,
  type LeagueFileRef,
  type LeagueProgress,
  type LeagueReservation,
  type LeaguePlan,
  type PublicLeagueWork,
} from '@fantasy/domain/spatial';
import { BattleBundles } from '@fantasy/api/artifacts';
import {
  progressPage,
  reserveLeaguePartition,
  validateLeaguePartition,
  validateLeaguePlan,
  verifyLeagueProgress,
  type LeagueCheckInput,
  type checkLeague,
} from '@fantasy/api/tooling';
import { leagueFile } from './league-export.ts';
import type { PublicationFile } from '../publication/publication-files.ts';

/** Build the durable admission/result journal without writing locally or remotely. */
export async function buildLeagueWork(
  plan: LeaguePlan,
  partitions: readonly { partition: unknown; batch: unknown }[],
  reservations: readonly LeagueReservation[],
  completed: readonly LeagueCheckInput[],
  prior: { ref: LeagueFileRef | null; records: readonly LeagueProgress[] },
  executionId: string,
  retained?: BattleBundles,
) {
  await validateLeaguePlan(plan);
  if (completed.length)
    throw new OperationError(
      'DATA_INVALID',
      'Results require an already published reservation journal',
    );
  if (partitions.length !== plan.partitions.length || reservations.length !== partitions.length)
    throw new OperationError('DATA_INVALID', 'Work journal must cover every league partition');
  const records = await verifyLeagueProgress(prior.records, retained);
  const seen = new Set<string>();
  for (const entry of partitions) {
    const { partition } = await validateLeaguePartition(plan, entry.partition, entry.batch);
    if (seen.has(partition.id))
      throw new OperationError('DATA_INVALID', 'Duplicate work partition');
    seen.add(partition.id);
    const reservation = reservations.find((r) => r.partitionId === partition.id);
    const expected = await reserveLeaguePartition(
      plan,
      partition,
      partition.slots.flatMap((slot) =>
        records.has(slot.simulationHash) ? [records.get(slot.simulationHash)!] : [],
      ),
      executionId,
      retained,
    );
    if (!reservation || canonicalJson(reservation) !== canonicalJson(expected))
      throw new OperationError(
        'DATA_INVALID',
        'Journal reservation does not extend retained attempts',
      );
    for (const record of reservation.progress.records) records.set(record.simulationHash, record);
  }
  return packLeagueWork(plan, reservations, [...records.values()], prior.ref, executionId);
}

/** Pack results already authenticated by exportLeague's checkLeague call. */
export async function finishCheckedLeagueWork(
  verified: Awaited<ReturnType<typeof checkLeague>>,
  reservations: readonly LeagueReservation[],
  reserved: { ref: LeagueFileRef; records: readonly LeagueProgress[]; work: PublicLeagueWork },
  retained: BattleBundles,
) {
  const { plan } = verified;
  if (
    reserved.work.planId !== plan.id ||
    reserved.work.sourceSha !== plan.source.sha ||
    reserved.work.reservations.length !== reservations.length
  )
    throw new OperationError(
      'DATA_INVALID',
      'Completion does not match the published reservation journal',
    );
  for (const reservation of reservations) {
    const ref = leagueFile(reservation).ref;
    if (
      !reserved.work.reservations.some(
        (r) =>
          r.partitionId === reservation.partitionId && r.hash === ref.hash && r.bytes === ref.bytes,
      )
    )
      throw new OperationError('DATA_INVALID', 'Completion reservation was not published');
  }
  const records = await verifyLeagueProgress(reserved.records, retained);
  for (const result of verified.results) {
    if (!reservations.some((r) => r.id === result.reservationId))
      throw new OperationError('DATA_INVALID', 'Unexpected completed reservation');
    for (const record of result.progress.records) records.set(record.simulationHash, record);
  }
  return packLeagueWork(
    plan,
    reservations,
    [...records.values()],
    reserved.ref,
    reserved.work.executionId,
  );
}

async function packLeagueWork(
  plan: LeaguePlan,
  reservations: readonly LeagueReservation[],
  records: readonly LeagueProgress[],
  previousWork: LeagueFileRef | null,
  executionId: string,
) {
  const files: PublicationFile[] = [];
  const add = (value: unknown) => {
    const { file, ref } = leagueFile(value);
    files.push(file);
    return ref;
  };
  const refs = reservations.map((reservation) => ({
    ...add(reservation),
    partitionId: reservation.partitionId,
  }));
  const ordered = [...records].sort((a, b) => a.simulationHash.localeCompare(b.simulationHash));
  const pages = [];
  for (let start = 0; start < ordered.length; start += 1000) {
    const page = await progressPage(ordered.slice(start, start + 1000));
    pages.push({ ...add(page), records: page.records.length });
  }
  const work = PublicLeagueWorkSchema.parse({
    schemaVersion: 1,
    executionId,
    sourceSha: plan.source.sha,
    inputHash: plan.revision.inputHash,
    planId: plan.id,
    previousWork,
    progress: pages,
    reservations: refs,
  });
  const ref = add(work);
  return { ref, files, work, records: ordered };
}
