import { afterEach, expect, it, vi } from 'vite-plus/test';
import { cp, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { Measurements } from '@fantasy/api/tooling';
import { LeagueCloudPreparedSchema } from '@fantasy/domain/spatial';
import { pipelineFixture, preparedPipeline } from '../apps/cli/test-support/league-pipeline.ts';
import * as runner from '../apps/cli/src/league/league-runner.ts';
import type { LeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { computePipeline } from './league-pipeline-compute.ts';
import {
  receivePipeline,
  receivePartitionPilot,
  receiveRunnerCalibration,
} from './league-pipeline-receive.ts';
import * as calibrationInputs from './league-partition-pilot-inputs.ts';
import * as calibrationBudget from './league-calibration-history.ts';
import * as uploads from './league-pipeline-upload.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import * as transport from '../apps/cli/src/league/league-producer-transport.ts';
import * as producers from '../apps/cli/src/league/league-producer.ts';
import * as cloudFiles from '../apps/cli/src/league/league-cloud-files.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const signal = () => new AbortController().signal;
const unusedStaging = () => ({ stage: vi.fn() }) as unknown as LeagueStaging;
const receiverStageNames = (measurement: Measurements) =>
  Object.keys(measurement.report().stages).filter((name) => name.startsWith('receiver.'));
async function writeReceiverProfile(
  fixture: Pick<
    Awaited<ReturnType<typeof preparedPipeline>>,
    'preparedRoot' | 'identity' | 'input'
  >,
  measurementHash: string,
) {
  const slot = fixture.input.batch.slots[0]!;
  await writeFile(
    join(fixture.preparedRoot, 'cost-profile.json'),
    JSON.stringify({
      schemaVersion: 1,
      source: fixture.identity.source,
      measurementHash,
      metric: 'worker-compute-elapsed-ms',
      samples: [
        {
          simulationHash: slot.simulationHash,
          scenario: slot.spec.scenario.id,
          characters: slot.spec.participants.map((p) => p.character.id),
          elapsedMs: 1,
        },
      ],
    }),
  );
}

async function diagnosticPrepared(root: string) {
  const fixture = await preparedPipeline(root);
  // Receiver-only protocol metadata: original-input verification is stubbed in these
  // rejection cases. Actual 380 manifests remain verified by the partition pilot tests.
  // Literal IDs are independent of the assignment algorithm and are never adopted.
  const prepared = LeagueCloudPreparedSchema.parse({
    ...fixture.prepared,
    plan: {
      ...fixture.prepared.plan,
      partitions: [
        {
          partitionId: 'sha256:' + '1'.repeat(64),
          batchPlanId: 'sha256:' + '4'.repeat(64),
          slots: 128,
        },
        {
          partitionId: 'sha256:' + '2'.repeat(64),
          batchPlanId: 'sha256:' + '5'.repeat(64),
          slots: 128,
        },
        {
          partitionId: 'sha256:' + '3'.repeat(64),
          batchPlanId: 'sha256:' + '6'.repeat(64),
          slots: 124,
        },
      ],
    },
    inputs: [
      { hash: 'sha256:' + '7'.repeat(64), bytes: 128 },
      { hash: 'sha256:' + '8'.repeat(64), bytes: 128 },
      { hash: 'sha256:' + '9'.repeat(64), bytes: 128 },
    ],
  });
  await writeFile(join(fixture.preparedRoot, 'prepared.json'), JSON.stringify(prepared));
  expect(prepared.inputs).toHaveLength(3);
  expect(prepared.plan.partitions.map((partition) => partition.slots)).toEqual([128, 128, 124]);
  return {
    prepared,
    input: fixture.input,
    preparedRoot: fixture.preparedRoot,
    github: new PipelineArtifacts('test', fixture.identity),
  };
}

async function calibrationReceiverProtocol(root: string) {
  const fixture = await diagnosticPrepared(root);
  const prepared = structuredClone(fixture.prepared);
  prepared.plan.partitions = prepared.plan.partitions.map((partition) => ({
    ...partition,
    slots: 95,
  }));
  prepared.plan.partitions.push({
    partitionId: 'sha256:' + 'c'.repeat(64),
    batchPlanId: 'sha256:' + 'd'.repeat(64),
    slots: 95,
  });
  prepared.inputs.push({ hash: 'sha256:' + 'e'.repeat(64), bytes: 128 });
  await writeFile(join(fixture.preparedRoot, 'prepared.json'), JSON.stringify(prepared));
  const github = new PipelineArtifacts(
    'test',
    fixture.github.identity,
    200,
    'league-runner-calibration.yml',
  );
  vi.spyOn(github, 'authenticateRun').mockResolvedValue({
    path: '.github/workflows/league-runner-calibration.yml',
  });
  // These cases isolate artifact dispatch, not original-input or budget authentication.
  // Real fresh 380-input and immutable budget-record verification have separate regressions.
  vi.spyOn(calibrationInputs, 'validateCalibrationPrepared').mockResolvedValue({
    prepared,
    registered: {} as never,
  });
  vi.spyOn(calibrationBudget, 'validateCalibrationBudgetRecord').mockResolvedValue(
    undefined as never,
  );
  return { ...fixture, prepared, github };
}

it.each([
  [2, 'prepare-shared'],
  [2, 'consume-shared'],
  [2, 'compute-0'],
  [2, 'compute-1'],
  [4, 'compute-2'],
  [4, 'compute-3'],
] as const)(
  'ignores bounded calibration %s-runner %s diagnostics without downloading or adopting them',
  async (runners, phase) => {
    await withReplayDirectory(async (root) => {
      const fixture = await calibrationReceiverProtocol(root);
      const metric = {
        id: 901,
        name: `league-123-1-${phase}-metrics`,
        digest: 'sha256:' + 'f'.repeat(64),
        bytes: 209031,
      };
      vi.spyOn(fixture.github, 'list').mockResolvedValue([metric]);
      const controller = new AbortController();
      const jobs = vi.spyOn(fixture.github, 'successfulProducers').mockImplementation(async () => {
        controller.abort();
        return false;
      });
      const download = vi.spyOn(fixture.github, 'download');
      const staging = unusedStaging();
      await expect(
        receiveRunnerCalibration(
          root,
          fixture.preparedRoot,
          fixture.github,
          runners,
          staging,
          controller.signal,
          async () => {},
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(jobs).toHaveBeenCalledOnce();
      expect(download).not.toHaveBeenCalled();
      expect(staging.stage).not.toHaveBeenCalled();
    });
  },
);

it.each([
  ['compute-2-metrics', 209031, 'Unexpected pipeline artifact'],
  ['compute-00-metrics', 209031, 'Unexpected pipeline artifact'],
  ['prepare-shared-metrics-extra', 209031, 'Unexpected pipeline artifact'],
  ['prepare-shared-metrics', 524289, 'Calibration metrics artifact exceeds encoded bound'],
] as const)(
  'rejects foreign or oversized calibration diagnostics %s',
  async (suffix, bytes, error) => {
    await withReplayDirectory(async (root) => {
      const fixture = await calibrationReceiverProtocol(root);
      vi.spyOn(fixture.github, 'list').mockResolvedValue([
        { id: 901, name: `league-123-1-${suffix}`, digest: 'sha256:' + 'f'.repeat(64), bytes },
      ]);
      const jobs = vi.spyOn(fixture.github, 'successfulProducers');
      const download = vi.spyOn(fixture.github, 'download');
      const staging = unusedStaging();
      await expect(
        receiveRunnerCalibration(
          root,
          fixture.preparedRoot,
          fixture.github,
          2,
          staging,
          signal(),
          async () => {},
        ),
      ).rejects.toThrow(error);
      expect(jobs).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      expect(staging.stage).not.toHaveBeenCalled();
    });
  },
);

it('preserves the existing partition pilot rejection of calibration metrics', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await diagnosticPrepared(root);
    vi.spyOn(fixture.github, 'list').mockResolvedValue([
      {
        id: 901,
        name: 'league-123-1-prepare-shared-metrics',
        digest: 'sha256:' + 'f'.repeat(64),
        bytes: 209031,
      },
    ]);
    await expect(
      receivePartitionPilot(
        root,
        fixture.preparedRoot,
        fixture.github,
        2,
        unusedStaging(),
        signal(),
        async () => {},
      ),
    ).rejects.toThrow('Unexpected pipeline artifact');
  });
});

// Protocol mocks below isolate receiver adoption ordering. They are not full packed authentication
// or fresh-computation evidence; real original-input and transport validation have separate tests.
async function packedReceiverProtocol(root: string) {
  const fixture = await diagnosticPrepared(root);
  const pack = {
    id: 801,
    name: 'league-123-1-runner-0-pack-0',
    digest: 'sha256:' + 'a'.repeat(64),
    bytes: 128,
  };
  const legacy = {
    id: 802,
    name: 'league-123-1-runner-0-partition-0-part-0-of-1',
    digest: 'sha256:' + 'b'.repeat(64),
    bytes: 128,
  };
  const staged: number[] = [];
  const producer = (partition: number) =>
    ({ proof: { partition }, evidence: {} }) as Awaited<
      ReturnType<typeof producers.authenticatePackedLeagueProducer>
    >;
  vi.spyOn(cloudFiles, 'cloudInput').mockResolvedValue(fixture.input);
  vi.spyOn(transport, 'authenticatePackedGroup').mockResolvedValue({
    artifact: pack,
    partitions: [0, 1],
  });
  const authenticate = vi
    .spyOn(producers, 'authenticatePackedLeagueProducer')
    .mockImplementation(async (path) => producer(Number(path.split(/[\\/]/).at(-1))));
  vi.spyOn(producers, 'authenticateLeagueProducer').mockResolvedValue(producer(0));
  const download = vi.spyOn(fixture.github, 'download').mockImplementation(async (ref, target) => {
    await mkdir(join(target, 'public'), { recursive: true });
    await writeFile(join(target, 'proof.json'), '{}');
    await writeFile(join(target, 'result.json'), '{}');
    return ref;
  });
  const jobs = vi.spyOn(fixture.github, 'successfulProducers').mockResolvedValue(false);
  const staging = unusedStaging();
  vi.mocked(staging.stage).mockImplementation(async (_evidence, path) => {
    const partition = Number(path.split(/[\\/]/).at(-2));
    staged.push(Number.isNaN(partition) ? 0 : partition);
    return { files: 0, bytes: 0 };
  });
  return { ...fixture, pack, legacy, authenticate, download, jobs, staging, staged };
}

it.each(['authenticate', 'stage'] as const)(
  'does not adopt a packed group after its second partition %s fails',
  async (failure) => {
    await withReplayDirectory(async (root) => {
      const fixture = await packedReceiverProtocol(root);
      vi.spyOn(fixture.github, 'list').mockResolvedValue([fixture.pack]);
      if (failure === 'authenticate')
        fixture.authenticate.mockImplementation(async (path) => {
          const partition = Number(path.split(/[\\/]/).at(-1));
          if (partition === 1) throw new Error('second partition authentication failed');
          return { proof: { partition }, evidence: {} } as Awaited<
            ReturnType<typeof producers.authenticatePackedLeagueProducer>
          >;
        });
      else
        vi.mocked(fixture.staging.stage).mockImplementation(async () => {
          if (vi.mocked(fixture.staging.stage).mock.calls.length === 2)
            throw new Error('second partition staging failed');
          return { files: 0, bytes: 0 };
        });
      await expect(
        receivePartitionPilot(
          root,
          fixture.preparedRoot,
          fixture.github,
          1,
          fixture.staging,
          signal(),
          async () => {},
        ),
      ).rejects.toThrow('second partition');
      expect(fixture.authenticate).toHaveBeenCalledTimes(2);
      expect(fixture.staging.stage).toHaveBeenCalledTimes(failure === 'authenticate' ? 0 : 2);
      expect(fixture.jobs).not.toHaveBeenCalled();
      expect(fixture.download).toHaveBeenCalledTimes(1);
      await expect(access(join(root, 'receive-packed-801'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

it.each(['packed-first', 'legacy-first'] as const)(
  'rejects cross-poll packed/legacy overlap: %s',
  async (order) => {
    await withReplayDirectory(async (root) => {
      const fixture = await packedReceiverProtocol(root);
      const first = order === 'packed-first' ? fixture.pack : fixture.legacy;
      const second = order === 'packed-first' ? fixture.legacy : fixture.pack;
      const list = vi
        .spyOn(fixture.github, 'list')
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([first, second]);
      // Exercise the real first 1000ms poll wait; do not replace the Node ESM timer export.
      const measurement = new Measurements();
      await expect(
        measurement.run(() =>
          receivePartitionPilot(
            root,
            fixture.preparedRoot,
            fixture.github,
            1,
            fixture.staging,
            signal(),
            async () => {},
          ),
        ),
      ).rejects.toThrow('Duplicate packed/legacy partition coverage');
      expect(list).toHaveBeenCalledTimes(2);
      expect(measurement.report().stages['receiver.pollWait']).toMatchObject({
        count: 1,
        failures: 0,
        incomplete: 0,
      });
      expect(fixture.staging.stage).toHaveBeenCalledTimes(order === 'packed-first' ? 2 : 1);
      expect(fixture.jobs).toHaveBeenCalledOnce();
    });
  },
);

it('keeps production profile preflight ahead of packed artifacts and rejects packs with a measured profile', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await packedReceiverProtocol(root);
    // Production uses its real small plan, not the diagnostic's synthetic three-partition metadata.
    const production = await preparedPipeline(join(root, 'production'));
    const list = vi.spyOn(fixture.github, 'list').mockResolvedValue([fixture.pack]);
    await expect(
      receivePipeline(root, production.preparedRoot, fixture.github, 1, fixture.staging, signal()),
    ).rejects.toThrow('Measured league cost profile required');
    expect(list).not.toHaveBeenCalled();
    await writeReceiverProfile(production, 'sha256:' + 'c'.repeat(64));
    await expect(
      receivePipeline(root, production.preparedRoot, fixture.github, 1, fixture.staging, signal()),
    ).rejects.toThrow('Unexpected packed pipeline artifact');
    expect(fixture.download).not.toHaveBeenCalled();
    expect(fixture.staging.stage).not.toHaveBeenCalled();
  });
});

it('observes authenticated receipt, staging and job stages without changing receiver results', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await pipelineFixture(root);
    await writeReceiverProfile(fixture, 'sha256:' + 'a'.repeat(64));
    const terminalRef = {
      id: 457,
      name: 'league-123-1-terminal-0',
      digest: 'sha256:' + 'd'.repeat(64),
      bytes: 128,
    };
    for (const failure of [
      'none',
      'list',
      'assemble',
      'authenticatePartition',
      'stage',
      'jobs',
    ] as const) {
      const github = new PipelineArtifacts('test', fixture.identity);
      vi.spyOn(github, 'list').mockImplementation(async () => {
        if (failure === 'list') throw new Error('list failure');
        return [...fixture.producer.artifacts, terminalRef];
      });
      vi.spyOn(github, 'download').mockImplementation(async (ref, target) => {
        if (ref.id === terminalRef.id) {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, 'terminal.json'), JSON.stringify(fixture.terminal));
        } else {
          if (failure === 'assemble') throw new Error('assemble failure');
          await cp(fixture.producerRoot, target, { recursive: true });
          if (failure === 'authenticatePartition') {
            const proof = JSON.parse(await readFile(join(target, 'proof.json'), 'utf8'));
            proof.resultHash = 'sha256:' + 'e'.repeat(64);
            await writeFile(join(target, 'proof.json'), JSON.stringify(proof));
          }
        }
        return ref;
      });
      vi.spyOn(github, 'successfulProducers').mockImplementation(async () => {
        if (failure === 'jobs') throw new Error('jobs failure');
        return true;
      });
      const staging = unusedStaging();
      vi.mocked(staging.stage).mockImplementation(async () => {
        if (failure === 'stage') throw new Error('stage failure');
        return { files: 0, bytes: 0 };
      });
      const measurement = new Measurements(),
        output = join(root, 'receive-' + failure);
      await mkdir(output);
      const pending = measurement.run(() =>
        receivePipeline(output, fixture.preparedRoot, github, 1, staging, signal()),
      );
      if (failure === 'none') {
        const received = await pending;
        expect(received.producers.map((p) => p.proof)).toEqual([fixture.producer.proof]);
        expect(received.terminals).toEqual([fixture.terminal]);
      } else
        await expect(pending).rejects.toThrow(
          failure === 'authenticatePartition' ? /identity/ : failure + ' failure',
        );
      const report = measurement.report();
      if (failure === 'none') {
        for (const stage of ['list', 'assemble', 'authenticatePartition', 'stage', 'jobs'])
          expect(report.stages['receiver.' + stage]).toMatchObject({
            count: 1,
            failures: 0,
            incomplete: 0,
          });
      } else
        expect(report.stages['receiver.' + failure]).toMatchObject({
          count: 1,
          failures: 1,
          incomplete: 0,
        });
      expect(report.stages['receiver.pollWait']).toBeUndefined();
      expect(report.incompleteSpans).toBe(0);
      expect(report.measuredSpanUnionMs).toBeLessThanOrEqual(report.wallMs);
    }
  });
});

it('measures an interrupted poll wait and drains its span without pretending jobs succeeded', async () => {
  await withReplayDirectory(async (root) => {
    const { preparedRoot, github } = await diagnosticPrepared(root);
    const controller = new AbortController();
    vi.spyOn(github, 'list').mockResolvedValue([]);
    vi.spyOn(github, 'successfulProducers').mockImplementation(async () => {
      setImmediate(() => controller.abort());
      return false;
    });
    const measurement = new Measurements();
    await expect(
      measurement.run(() =>
        receivePartitionPilot(
          root,
          preparedRoot,
          github,
          1,
          unusedStaging(),
          controller.signal,
          async () => {},
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(measurement.report().stages).toMatchObject({
      'receiver.list': { count: 1, failures: 0, incomplete: 0 },
      'receiver.jobs': { count: 1, failures: 0, incomplete: 0 },
      'receiver.pollWait': { count: 1, failures: 1, incomplete: 0 },
    });
    expect(measurement.report().incompleteSpans).toBe(0);
  });
});

it('records only the list stage when foreign artifact names are rejected', async () => {
  await withReplayDirectory(async (root) => {
    const { preparedRoot, github } = await diagnosticPrepared(root);
    vi.spyOn(github, 'list').mockResolvedValue([
      { id: 789, name: 'foreign-artifact', digest: 'sha256:' + 'f'.repeat(64), bytes: 128 },
    ]);
    const measurement = new Measurements();
    await expect(
      measurement.run(() =>
        receivePartitionPilot(
          root,
          preparedRoot,
          github,
          1,
          unusedStaging(),
          signal(),
          async () => {},
        ),
      ),
    ).rejects.toThrow('Unexpected pipeline artifact');
    expect(receiverStageNames(measurement)).toEqual(['receiver.list']);
    expect(measurement.report().stages['receiver.list']).toMatchObject({
      count: 1,
      failures: 0,
      incomplete: 0,
    });
  });
});

it('keeps measured costs mandatory for production before listing artifacts', async () => {
  await withReplayDirectory(async (root) => {
    const { identity, preparedRoot } = await preparedPipeline(root);
    const github = new PipelineArtifacts('test', identity),
      list = vi.spyOn(github, 'list');
    const measurement = new Measurements();
    await expect(
      measurement.run(() =>
        receivePipeline(root, preparedRoot, github, 1, unusedStaging(), signal()),
      ),
    ).rejects.toThrow('Measured league cost profile required');
    expect(list).not.toHaveBeenCalled();
    expect(receiverStageNames(measurement)).toEqual([]);
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
    const measurement = new Measurements();
    await expect(
      measurement.run(() =>
        receivePartitionPilot(
          root,
          join(root, 'absent'),
          github,
          1,
          unusedStaging(),
          signal(),
          binding,
        ),
      ),
    ).rejects.toThrow('Original input changed');
    expect(binding).toHaveBeenCalledWith(join(root, 'absent'));
    expect(list).not.toHaveBeenCalled();
    expect(receiverStageNames(measurement)).toEqual([]);
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
      const { preparedRoot, github } = await diagnosticPrepared(root);
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
            partitions: variant === 'partitions' ? [0] : [0, 1, 2],
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
