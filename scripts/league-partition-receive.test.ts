import { afterEach, expect, it, vi } from 'vite-plus/test';
import { cp, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leagueFixture } from '@fantasy/samples/testing';
import { prepareCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { assignLeagueRunners } from '../apps/cli/src/league/league-assignment.ts';
import { preparedPipeline } from '../apps/cli/test-support/league-pipeline.ts';
import * as runner from '../apps/cli/src/league/league-runner.ts';
import type { LeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { computePipeline } from './league-pipeline-compute.ts';
import { receivePipeline, receivePartitionPilot } from './league-pipeline-receive.ts';
import * as uploads from './league-pipeline-upload.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const signal = () => new AbortController().signal;
const unusedStaging = () => ({ stage: vi.fn() }) as unknown as LeagueStaging;

async function diagnosticPrepared(root: string) {
  const { identity } = pipelineActionsFixture();
  const definition = { ...(await leagueFixture(20, 1)), trials: 1 };
  const preparedRoot = join(root, 'prepared');
  const { prepared } = await prepareCloudLeague(
    definition,
    identity.source,
    'league-123-1',
    join(root, 'baseline'),
    preparedRoot,
    { files: 0, bytes: 0, receipts: 0, usedReadRequests: 10000, usedWriteRequests: 10000 },
  );
  expect(prepared.inputs).toHaveLength(3);
  expect(prepared.plan.partitions.map((partition) => partition.slots)).toEqual([128, 128, 124]);
  return { prepared, preparedRoot, github: new PipelineArtifacts('test', identity) };
}

it('keeps measured costs mandatory for production before listing artifacts', async () => {
  await withReplayDirectory(async (root) => {
    const { identity, preparedRoot } = await preparedPipeline(root);
    const github = new PipelineArtifacts('test', identity),
      list = vi.spyOn(github, 'list');
    await expect(
      receivePipeline(root, preparedRoot, github, 1, unusedStaging(), signal()),
    ).rejects.toThrow('Measured league cost profile required');
    expect(list).not.toHaveBeenCalled();
  });
});

it('rejects diagnostic original-input binding before filesystem reception or API calls', async () => {
  await withReplayDirectory(async (root) => {
    const { identity } = pipelineActionsFixture();
    const github = new PipelineArtifacts('test', identity),
      list = vi.spyOn(github, 'list');
    const binding = vi.fn(async () => {
      throw new Error('Original input changed');
    });
    await expect(
      receivePartitionPilot(
        root,
        join(root, 'absent'),
        github,
        1,
        unusedStaging(),
        signal(),
        binding,
      ),
    ).rejects.toThrow('Original input changed');
    expect(binding).toHaveBeenCalledWith(join(root, 'absent'));
    expect(list).not.toHaveBeenCalled();
  });
});

it.each([
  'slots',
  'partitions',
  'inputs',
  'zero-runners',
  'three-runners',
  'fractional-runners',
] as const)('rejects diagnostic %s scope before artifact API use', async (variant) => {
  await withReplayDirectory(async (root) => {
    const { prepared, preparedRoot, github } = await diagnosticPrepared(root);
    if (variant === 'slots') prepared.plan.partitions[0]!.slots--;
    if (variant === 'partitions') prepared.plan.partitions.pop();
    if (variant === 'inputs') prepared.inputs.pop();
    await writeFile(join(preparedRoot, 'prepared.json'), JSON.stringify(prepared));
    const runners =
      variant === 'zero-runners'
        ? 0
        : variant === 'three-runners'
          ? 3
          : variant === 'fractional-runners'
            ? 1.5
            : 1;
    const list = vi.spyOn(github, 'list'),
      binding = vi.fn(async () => {});
    await expect(
      receivePartitionPilot(
        root,
        preparedRoot,
        github,
        runners,
        unusedStaging(),
        signal(),
        binding,
      ),
    ).rejects.toThrow('Partition pilot scope mismatch');
    expect(binding).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });
});

it.each([1, 2])(
  'retains finished-job and complete-artifact coverage barriers for %i diagnostic runners',
  async (runners) => {
    await withReplayDirectory(async (root) => {
      const { preparedRoot, github } = await diagnosticPrepared(root);
      const list = vi.spyOn(github, 'list').mockResolvedValue([]);
      vi.spyOn(github, 'successfulProducers').mockResolvedValue(true);
      const staging = unusedStaging();
      await expect(
        receivePartitionPilot(
          root,
          preparedRoot,
          github,
          runners,
          staging,
          signal(),
          async () => {},
        ),
      ).rejects.toThrow('Successful jobs have incomplete artifact coverage');
      expect(list).toHaveBeenCalledOnce();
      expect(github.successfulProducers).toHaveBeenCalledWith(runners);
      expect(staging.stage).not.toHaveBeenCalled();
    });
  },
);

it.each(['source', 'attempt', 'runner', 'partitions'] as const)(
  'rejects foreign terminal %s binding before adopting results',
  async (variant) => {
    await withReplayDirectory(async (root) => {
      const { preparedRoot, prepared, github } = await diagnosticPrepared(root);
      vi.spyOn(github, 'list').mockResolvedValue([
        {
          id: 456,
          name: 'league-123-1-terminal-0',
          digest: 'sha256:' + 'c'.repeat(64),
          bytes: 128,
        },
      ]);
      vi.spyOn(github, 'download').mockImplementation(async (ref, target) => {
        await mkdir(target, { recursive: true });
        const identity = structuredClone(github.identity);
        if (variant === 'source') identity.source.sha = 'd'.repeat(40);
        if (variant === 'attempt') identity.runAttempt = 2;
        await writeFile(
          join(target, 'terminal.json'),
          JSON.stringify({
            schemaVersion: 1,
            identity,
            runner: variant === 'runner' ? 1 : 0,
            partitions:
              variant === 'partitions' ? [0] : assignLeagueRunners(prepared.plan, 1)[0]!.partitions,
            artifacts: [
              {
                id: 789,
                name: 'league-123-1-runner-0-partition-0-part-0-of-1',
                digest: 'sha256:' + 'e'.repeat(64),
                bytes: 128,
              },
            ],
          }),
        );
        return ref;
      });
      const staging = unusedStaging();
      await expect(
        receivePartitionPilot(root, preparedRoot, github, 1, staging, signal(), async () => {}),
      ).rejects.toThrow('Terminal assignment mismatch');
      expect(staging.stage).not.toHaveBeenCalled();
    });
  },
);

it('rejects a post-download compute guard before simulation, publication or terminal upload', async () => {
  await withReplayDirectory(async (root) => {
    const { identity, preparedRoot, prepared } = await preparedPipeline(root);
    const github = new PipelineArtifacts('test', identity);
    const artifact = {
      id: 456,
      name: 'league-123-1-inputs',
      digest: 'sha256:' + 'c'.repeat(64),
      bytes: 128,
    };
    vi.spyOn(github, 'list').mockResolvedValue([artifact]);
    const download = vi.spyOn(github, 'download').mockImplementation(async (ref, target) => {
      await cp(preparedRoot, target, { recursive: true });
      await writeFile(
        join(target, 'control.json'),
        JSON.stringify({
          schemaVersion: 1,
          identity,
          runners: 1,
          ciRunId: 123,
          catalogHash: prepared.work.hash,
          admissionWrites: 1,
        }),
      );
      return ref;
    });
    const run = vi.spyOn(runner, 'runCloudLeagueRunner'),
      upload = vi.spyOn(uploads, 'uploadPipelineArtifact');
    const guard = vi.fn(async (downloadedRoot: string) => {
      expect(
        JSON.parse(await readFile(join(downloadedRoot, 'control.json'), 'utf8')).identity,
      ).toEqual(identity);
      throw new Error('Original downloaded input changed');
    });
    const output = join(root, 'compute');
    await expect(computePipeline(output, github, identity, 0, signal(), guard)).rejects.toThrow(
      'Original downloaded input changed',
    );
    expect(download).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledWith(join(output, 'prepared'));
    expect(run).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    for (const path of ['results', 'spool', 'terminal.json'])
      await expect(access(join(output, path))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
