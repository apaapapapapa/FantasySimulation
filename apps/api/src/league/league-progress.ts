import { OperationError, operationInput } from '../operation-error.ts';
import {
  compareIds,
  contentHash,
  parseJson,
  LeagueProgressSchema,
  LeagueProgressPageSchema,
  LeagueProgressPageBodySchema,
  LeagueReservationSchema,
  type LeagueProgress,
  type LeagueProgressPage,
  type LeaguePlan,
  type LeaguePartition,
} from '@fantasy/domain/spatial';
import type { BattleBundles } from '../batch/battle-bundle.ts';

export function leagueProgressMap(input: readonly LeagueProgress[]) {
  if (input.length > 64000) throw new OperationError('BUDGET_EXCEEDED', 'League progress limit');
  const records = new Map<string, LeagueProgress>();
  for (const value of input) {
    const record = LeagueProgressSchema.parse(value);
    if (records.has(record.simulationHash))
      throw new OperationError('DATA_INVALID', 'Duplicate league progress');
    records.set(record.simulationHash, record);
  }
  return records;
}

/** A reserved attempt counts even if its job dies before returning an index. */
export function nextLeagueAttempt(record?: LeagueProgress): 1 | 2 | null {
  if (!record) return 1;
  const checked = LeagueProgressSchema.parse(record);
  if (!checked.attempts.length) return 1;
  if (checked.attempts.length >= 2 || ['win', 'draw'].includes(checked.attempts.at(-1)!.state))
    return null;
  return 2;
}

export async function verifyLeagueProgress(
  input: readonly LeagueProgress[],
  bundles?: BattleBundles,
) {
  const records = leagueProgressMap(input);
  for (const record of records.values())
    for (const attempt of record.attempts) {
      if (!attempt.objectHash) continue;
      if (!bundles)
        throw new OperationError('DATA_INVALID', 'Retained progress requires verified bundles');
      const receipt = await bundles.verify(attempt.objectHash);
      if (
        receipt.simulationHash !== record.simulationHash ||
        receipt.result.outcome.kind !== attempt.state
      )
        throw new OperationError('DATA_INVALID', 'Progress and verified result disagree');
    }
  return records;
}

export async function progressPage(
  records: readonly LeagueProgress[],
): Promise<LeagueProgressPage> {
  const body = parseJson(LeagueProgressPageBodySchema, {
    schemaVersion: 1,
    records: [...leagueProgressMap(records).values()].sort((a, b) =>
      compareIds(a.simulationHash, b.simulationHash),
    ),
  });
  return { ...body, id: await contentHash(body) };
}

export async function validateProgressPage(input: unknown) {
  const page = operationInput(() => parseJson(LeagueProgressPageSchema, input), 'DATA_INVALID'),
    { id, ...body } = page;
  if (id !== (await contentHash(body)))
    throw new OperationError('DATA_INVALID', 'Progress page checksum mismatch');
  leagueProgressMap(page.records);
  return page;
}

export async function validateLeagueReservation(
  plan: LeaguePlan,
  partition: LeaguePartition,
  input: unknown,
) {
  const reservation = parseJson(LeagueReservationSchema, input),
    { id, ...body } = reservation;
  if (
    id !== (await contentHash(body)) ||
    reservation.planId !== plan.id ||
    reservation.partitionId !== partition.id
  )
    throw new OperationError('DATA_INVALID', 'League reservation identity mismatch');
  await validateProgressPage(reservation.progress);
  const records = leagueProgressMap(reservation.progress.records);
  if (
    records.size !== partition.slots.length ||
    partition.slots.some((slot) => !records.has(slot.simulationHash))
  )
    throw new OperationError('DATA_INVALID', 'Reservation does not cover the partition');
  return reservation;
}
