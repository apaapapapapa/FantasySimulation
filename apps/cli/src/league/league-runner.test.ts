import { expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { join } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { BattlePool } from '@fantasy/api/tooling';
import { runnerFixture } from '../../test-support/league-runners.ts';
import { runCloudLeagueRunner } from './league-runner.ts';
import { assignLeagueRunners, requireLeagueAssignment } from './league-assignment.ts';
import { leagueArtifactFiles } from './league-artifact-files.ts';

it('reuses one pool across partitions and emits only durably completed results', async () => {
  await withReplayDirectory(async (root) => {
    const input = join(root, 'input'),
      output = join(root, 'output');
    const fixture = await runnerFixture(input);
    const pools = new Set<BattlePool>();
    const closed = vi.spyOn(BattlePool.prototype, 'close');
    try {
      const result = await runCloudLeagueRunner(
        input,
        output,
        fixture.source,
        fixture.executionId,
        {
          runner: 0,
          runners: 1,
          workers: 1,
          completed: async (_, directory, pool) => {
            pools.add(pool);
            const saved = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
            expect(saved.index.complete).toBe(true);
            expect(await readdir(join(directory, 'results'))).toEqual([
              saved.id.slice(7) + '.json',
            ]);
          },
        },
      );
      expect(result.results).toHaveLength(4);
      expect(pools.size).toBe(1);
      expect(closed).toHaveBeenCalledTimes(1);
      expect((await leagueArtifactFiles(input, 'inputs')).files).toHaveLength(5);
    } finally {
      closed.mockRestore();
    }
  });
}, 30000);

it('rejects a tampered later input before any claim and stops after callback failure', async () => {
  await withReplayDirectory(async (root) => {
    const input = join(root, 'input'),
      output = join(root, 'output');
    const { prepared, source, executionId } = await runnerFixture(input);
    const assignment = assignLeagueRunners(prepared.plan, 1)[0]!;
    const path = join(input, 'inputs', String(assignment.partitions.at(-1)), 'input.json');
    const original = await readFile(path);
    await writeFile(path, '{}');
    await expect(
      runCloudLeagueRunner(input, output, source, executionId, {
        runner: 0,
        runners: 1,
        workers: 1,
      }),
    ).rejects.toThrow('checksum');
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, original);
    const closed = vi.spyOn(BattlePool.prototype, 'close');
    try {
      await expect(
        runCloudLeagueRunner(input, output, source, executionId, {
          runner: 0,
          runners: 1,
          workers: 1,
          completed: async () => {
            throw new Error('upload failed');
          },
        }),
      ).rejects.toThrow('upload failed');
      expect(await readdir(output)).toEqual([String(assignment.partitions[0])]);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      closed.mockRestore();
    }
  });
}, 30000);

it.each([16, 32])(
  'covers sixty partitions exactly with %i bounded deterministic runners',
  async (runners) => {
    await withReplayDirectory(async (root) => {
      const { prepared } = await runnerFixture(root);
      const plan = {
        ...prepared.plan,
        partitions: Array.from({ length: 60 }, (_, index) => ({
          ...prepared.plan.partitions[0]!,
          partitionId: 'sha256:' + index.toString(16).padStart(64, '0'),
          slots: 128,
        })),
      };
      const costs = new Map(plan.partitions.map((p, i) => [p.partitionId, i + 1]));
      const assigned = assignLeagueRunners(plan, runners, costs);
      expect(assigned).toHaveLength(runners);
      expect(assigned[0]!.partitions[0]).toBe(59);
      expect(assigned.flatMap((a) => a.partitions).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 60 }, (_, i) => i),
      );
      expect(requireLeagueAssignment(plan, assigned, runners, costs)).toEqual(assigned);
      expect(() => requireLeagueAssignment(plan, assigned, runners)).toThrow('assignment');
    });
  },
);
