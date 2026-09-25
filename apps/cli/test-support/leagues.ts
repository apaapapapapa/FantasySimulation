import { join } from 'node:path';
import { BattleBundles } from '@fantasy/api/artifacts';
import {
  planLeague,
  reserveLeaguePartition,
  runLeaguePartition,
  type LeagueCheckInput,
} from '@fantasy/api/tooling';
import { leagueFixture, leagueEstimate, leagueSource } from '@fantasy/samples/testing';
import type { LeagueDefinition, LeagueProgress, LeagueReservation } from '@fantasy/domain/spatial';

export const publicationLeagueSource = {
  sha: leagueSource,
  node: '24.19.0',
  platform: 'linux' as const,
  arch: 'x64' as const,
};
export async function leaguePublicationFixture(
  root: string,
  options: {
    definition?: LeagueDefinition;
    size?: number;
    history?: LeagueProgress[];
    retained?: BattleBundles;
    executionId?: string;
    source?: typeof publicationLeagueSource;
  } = {},
) {
  const history = options.history ?? [],
    executionId = options.executionId ?? 'league-fixture',
    source = options.source ?? publicationLeagueSource;
  const prepared = await planLeague(
    options.definition ?? (await leagueFixture(2, 1)),
    source,
    { ...leagueEstimate, matchesPerPlan: options.size ?? 128 },
    history,
    options.retained,
  );
  const completed: LeagueCheckInput[] = [],
    reservations: LeagueReservation[] = [];
  for (const entry of prepared.partitions) {
    const reservation = await reserveLeaguePartition(
      prepared.plan,
      entry.partition,
      history,
      executionId,
      options.retained,
    );
    const output = join(root, String(entry.partition.index));
    const result = await runLeaguePartition(
      prepared.plan,
      entry.partition,
      entry.batch,
      reservation,
      output,
      source,
      executionId,
      { ...(options.retained ? { retained: options.retained } : {}) },
    );
    completed.push({
      ...entry,
      reservation,
      result,
      bundles: new BattleBundles(join(output, 'bundles')),
    });
    reservations.push(reservation);
  }
  return { ...prepared, completed, reservations, executionId };
}
