import { join } from 'node:path';
import { planLeague, reserveLeaguePartition } from '@fantasy/api/tooling';
import { leagueFixture, leagueEstimate } from '@fantasy/samples/testing';
import { publicationLeagueSource } from './leagues.ts';
import { writeCloudJson } from '../src/league/league-cloud-files.ts';
import { buildLeagueWork } from '../src/league/league-work.ts';

export async function runnerFixture(root: string, scenarios = 1) {
  const source = publicationLeagueSource,
    executionId = 'runner-fixture';
  const planned = await planLeague(await leagueFixture(2, scenarios), source, {
    ...leagueEstimate,
    matchesPerPlan: 1,
  });
  const reservations = await Promise.all(
    planned.partitions.map(({ partition }) =>
      reserveLeaguePartition(planned.plan, partition, [], executionId),
    ),
  );
  const work = await buildLeagueWork(
    planned.plan,
    planned.partitions,
    reservations,
    [],
    { ref: null, records: [] },
    executionId,
  );
  const inputs = [];
  for (const [index, entry] of planned.partitions.entries())
    inputs.push(
      await writeCloudJson(join(root, 'inputs', String(index), 'input.json'), {
        schemaVersion: 1,
        plan: planned.plan,
        ...entry,
        reservation: reservations[index],
        work: work.ref,
      }),
    );
  const prepared = {
    schemaVersion: 1 as const,
    plan: planned.plan,
    executionId,
    work: work.ref,
    inputs,
  };
  await writeCloudJson(join(root, 'prepared.json'), prepared);
  return { prepared, source, executionId };
}
