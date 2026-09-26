import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicLeagueWorkSchema,
  PublicLeagueSnapshotSchema,
  type LeagueFileRef,
  type LeagueProgress,
  type PublicCatalog,
} from '@fantasy/domain/spatial';
import { createLeagueRevision, leagueMatches } from '@fantasy/engine/spatial';
import { validateProgressPage, estimateLeague } from '@fantasy/api/tooling';
import { sha256 } from '@fantasy/api/artifacts';
import type { PublicationRead } from '../publication/publication-graph.ts';
import { OperationError, operationInput } from '@fantasy/api/tooling';
import { PublicReadFailure } from '../publication/publication-http.ts';

export const LEAGUE_PROFILE = {
  matchesPerPlan: 128,
  estimatedMsPerMatch: 4000,
  estimatedBytesPerMatch: 600000,
  estimatedFilesPerMatch: 44,
  retainedBytes: 0,
  retainedFiles: 0,
  maxReadRequests: 9000000,
  maxWriteRequests: 900000,
  usedReadRequests: 10000,
  usedWriteRequests: 10000,
};

/** Cheap checksum-bound metadata probe; actual admission re-verifies every retained bundle. */
export async function probeLeague(input: unknown, sourceSha: string, read: PublicationRead) {
  let requests = 0,
    bytes = 0;
  const json = async (key: string, ref?: LeagueFileRef): Promise<unknown> => {
    if (++requests > 96) throw new OperationError('BUDGET_EXCEEDED', 'League probe request budget');
    const data = await read(key, ref?.bytes ?? 4000000);
    bytes += data.length;
    if (bytes > 64000000) throw new OperationError('BUDGET_EXCEEDED', 'League probe byte budget');
    if (
      data.length > (ref?.bytes ?? 4000000) ||
      (ref && (data.length !== ref.bytes || sha256(data) !== ref.hash))
    )
      throw new OperationError('DATA_INVALID', 'League probe checksum/size budget');
    return operationInput(
      () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)),
      'DATA_INVALID',
    );
  };
  const leagueJson = (ref: LeagueFileRef) => json(`leagues/${ref.hash.slice(7)}.json`, ref);
  const saved = <T>(schema: { parse(value: unknown): T }, value: unknown) =>
    operationInput(() => schema.parse(value), 'DATA_INVALID');
  let catalog: PublicCatalog | undefined;
  try {
    const pointer = saved(PublicCatalogCurrentSchema, await json('catalog/current.json'));
    catalog = saved(
      PublicCatalogSchema,
      await json(`catalog/${pointer.catalogHash.slice(7)}.json`, {
        hash: pointer.catalogHash,
        bytes: pointer.bytes,
      }),
    );
  } catch (error) {
    if (requests !== 1 || !(error instanceof PublicReadFailure) || error.status !== 404)
      throw error;
  }
  const records = new Map<string, LeagueProgress>();
  if (catalog?.leagueWork) {
    const work = saved(PublicLeagueWorkSchema, await leagueJson(catalog.leagueWork));
    for (const ref of work.progress) {
      const page = await validateProgressPage(await leagueJson(ref));
      if (page.records.length !== ref.records)
        throw new OperationError('DATA_INVALID', 'League probe progress count');
      for (const record of page.records) {
        if (records.has(record.simulationHash))
          throw new OperationError('DATA_INVALID', 'Duplicate league probe history');
        records.set(record.simulationHash, record);
      }
    }
  }
  const revision = await createLeagueRevision(input, sourceSha);
  let reused = 0,
    retries = 0,
    exhausted = 0;
  for await (const { slot } of leagueMatches(revision)) {
    const attempts = records.get(slot.simulationHash)?.attempts ?? [];
    if (['win', 'draw'].includes(attempts.at(-1)?.state ?? '')) reused++;
    else if (attempts.length >= 2) exhausted++;
    else if (attempts.length) retries++;
  }
  const ref = catalog?.leagues?.find((entry) => entry.id === revision.definition.id);
  const snapshot = ref ? saved(PublicLeagueSnapshotSchema, await leagueJson(ref)) : undefined;
  if (ref && (snapshot?.leagueHash !== ref.leagueHash || snapshot.inputHash !== ref.inputHash))
    throw new OperationError('DATA_INVALID', 'League probe catalog identity');
  const estimate = estimateLeague(revision.definition, LEAGUE_PROFILE, {
    reused,
    retries,
    exhausted,
  });
  return {
    sourceSha,
    inputHash: revision.inputHash,
    requests,
    bytes,
    estimate,
    needed:
      estimate.compute > 0 ||
      snapshot?.inputHash !== revision.inputHash ||
      snapshot.standings.resolved !== reused,
    reuseVerification: 'Published metadata only; admission verifies retained bundle checksums.',
    retentionVerification:
      'Estimate excludes retained storage; R2 inventory and cumulative usage are checked before admission.',
  };
}
