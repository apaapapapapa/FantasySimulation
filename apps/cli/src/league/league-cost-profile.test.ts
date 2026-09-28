import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { runnerFixture } from '../../test-support/league-runners.ts';
import { preparedLeagueCosts } from './league-cost-profile.ts';
import { cloudInput, writeCloudJson } from './league-cloud-files.ts';
import { assignLeagueRunners } from './league-assignment.ts';

it('uses pair, field and global medians as hints without changing the archived plan or reservation', async () => {
  await withReplayDirectory(async (root) => {
    const { prepared, source } = await runnerFixture(root, 2),
      snapshot = JSON.stringify(prepared);
    const first = await cloudInput(root, prepared, 0),
      second = await cloudInput(root, prepared, 4);
    const a = first.batch.slots[0]!,
      b = second.batch.slots[0]!;
    const sample = (scenario: string, characters: string[], elapsedMs: number) => ({
      simulationHash: a.simulationHash,
      scenario,
      characters,
      elapsedMs,
    });
    const profile = {
      schemaVersion: 1,
      source,
      measurementHash: 'sha256:' + 'a'.repeat(64),
      metric: 'worker-compute-elapsed-ms',
      samples: [
        sample(
          a.spec.scenario.id,
          a.spec.participants.map((p) => p.character.id),
          10,
        ),
        sample(
          a.spec.scenario.id,
          a.spec.participants.map((p) => p.character.id),
          30,
        ),
        sample(b.spec.scenario.id, ['unrelated-a', 'unrelated-b'], 70),
      ],
    };
    await expect(preparedLeagueCosts(root, prepared, true)).rejects.toThrow('required');
    await writeCloudJson(join(root, 'cost-profile.json'), profile);
    const costs = await preparedLeagueCosts(root, prepared, true);
    expect(costs.get(first.partition.id)).toBe(20);
    expect(costs.get(second.partition.id)).toBe(70);
    await rm(join(root, 'cost-profile.json'));
    await writeCloudJson(join(root, 'cost-profile.json'), {
      ...profile,
      samples: profile.samples.slice(0, 2),
    });
    expect((await preparedLeagueCosts(root, prepared, true)).get(second.partition.id)).toBe(20);
    const assignment = assignLeagueRunners(prepared.plan, 2, costs);
    expect(assignment.flatMap((v) => v.partitions).sort((x, y) => x - y)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(JSON.stringify(prepared)).toBe(snapshot);
  });
});
