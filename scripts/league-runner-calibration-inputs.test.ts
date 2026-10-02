import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { publicationLeagueSource as source } from '../apps/cli/test-support/leagues.ts';
import { leagueValidatorDigest } from '../apps/cli/src/league/league-validator.ts';
import { prepareCalibrationCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { assignLeagueRunners } from '../apps/cli/src/league/league-assignment.ts';
import {
  partitionPilotInputs,
  validateCalibrationPrepared,
  validatePartitionPilotPrepared,
  partitionPilotRunners,
} from './league-partition-pilot-inputs.ts';

it('assembles exactly four original fresh 95-match partitions, balanced at both diagnostic widths', async () => {
  await withReplayDirectory(async (root) => {
    const publicRoot = join(root, 'public'),
      preparedRoot = join(root, 'prepared');
    await mkdir(publicRoot);
    const registration = await partitionPilotInputs();
    const identity = {
      source,
      runId: 123,
      runAttempt: 1,
      validatorDigest: await leagueValidatorDigest(process.cwd()),
    };
    await prepareCalibrationCloudLeague(
      registration.definition,
      source,
      'league-123-1',
      publicRoot,
      preparedRoot,
      {
        files: 0,
        bytes: 0,
        receipts: 0,
        usedReadRequests: 10000,
        usedWriteRequests: 10000,
      },
    );
    for (const runners of [2, 4]) {
      const { prepared, registered } = await validateCalibrationPrepared(
        preparedRoot,
        identity,
        runners,
      );
      expect(registered.expected).toEqual(registration.expected);
      const assignments = assignLeagueRunners(prepared.plan, runners);
      expect(assignments).toHaveLength(runners);
      expect(assignments.map((entry) => entry.partitions.length)).toEqual(
        Array(runners).fill(4 / runners),
      );
      expect(assignments.map((entry) => entry.cost)).toEqual(Array(runners).fill(380 / runners));
      expect(new Set(assignments.flatMap((entry) => entry.partitions)).size).toBe(4);
    }
    await expect(validatePartitionPilotPrepared(preparedRoot, identity, 2)).rejects.toThrow(
      'partition coverage mismatch',
    );
    expect(() => validateCalibrationPrepared(preparedRoot, identity, 5)).toThrow('two or four');
    await expect(
      validateCalibrationPrepared(preparedRoot, { ...identity, runAttempt: 2 }, 4),
    ).rejects.toThrow('execution mismatch');
    expect(() => partitionPilotRunners(4)).toThrow('one or two');
  });
}, 60000);
