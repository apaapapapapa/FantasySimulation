import { afterEach, expect, it, vi } from 'vite-plus/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { cloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import {
  evidenceGraph,
  PublicationEvidence,
} from '../apps/cli/src/publication/publication-evidence.ts';
import {
  partitionPilotInputs,
  partitionPilotRunners,
  validatePartitionPilotPrepared,
} from './league-partition-pilot-inputs.ts';
import { preparePartitionPilot, computePartitionPilot } from './league-partition-pilot-driver.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import * as policy from './league-pipeline-policy.ts';

vi.mock('./league-pipeline-upload.ts', () => ({ uploadPipelineArtifact: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it.each([0, 3, 4, 5, 32, NaN, 1.5])(
  'rejects pilot topology %s before artifacts',
  async (runners) => {
    const { identity } = pipelineActionsFixture();
    const context = {
      root: 'unused',
      identity,
      token: 'test',
      prefix: 'league-123-1',
      ciRun: 123,
      github: new PipelineArtifacts('test', identity),
    };
    expect(() => partitionPilotRunners(runners)).toThrow('one or two');
    await expect(preparePartitionPilot(context, runners)).rejects.toThrow('one or two');
    await expect(
      computePartitionPilot(context, runners, 0, new AbortController().signal),
    ).rejects.toThrow('one or two');
    expect(uploadPipelineArtifact).not.toHaveBeenCalled();
  },
);

it('preserves exact original 380 inputs and full-size/scale-up holds', async () => {
  const registration = await partitionPilotInputs();
  expect(registration.expected).toHaveLength(380);
  expect(new Set(registration.expected.map((entry) => entry.slotId)).size).toBe(380);
  expect(registration.definition.masterSeed).toBe(20260925);
  expect(registration.definition.placements).toEqual(['normal', 'swapped']);
  expect(registration.definition.trials).toBe(1);
  expect(registration.definition.battlefields.map((field) => field.scenario.id)).toEqual([
    'aerial-surveyed-v1',
  ]);
});

it('prepares real fresh partitions with local accounting and immutable SDK refs, never a fabricated profile', async () => {
  await withReplayDirectory(async (root) => {
    const { identity } = pipelineActionsFixture();
    const context = {
      root,
      identity,
      token: 'test',
      prefix: 'league-123-1',
      ciRun: 123,
      github: new PipelineArtifacts('test', identity),
    };
    const ci = vi.spyOn(policy, 'pipelineCi').mockResolvedValue(identity.source.sha);
    // Explicit synthetic upload boundary; neither refs nor this fixture constitute real SDK evidence.
    vi.mocked(uploadPipelineArtifact).mockImplementation(async (name) => ({
      id: name.endsWith('-inputs') ? 1 : 2,
      name,
      bytes: 100,
      digest: 'sha256:' + 'c'.repeat(64),
    }));
    const outcome = await preparePartitionPilot(context, 2);
    expect(ci).toHaveBeenCalledOnce();
    expect(outcome.assignment.map((entry) => entry.runner)).toEqual([0, 1]);
    expect(outcome.assignment.flatMap((entry) => entry.partitions).sort()).toEqual([0, 1, 2]);
    const control = (await cloudJson(join(root, 'prepared/control.json'))) as {
      admissionWrites: number;
    };
    const graph = evidenceGraph(await PublicationEvidence.audit(join(root, 'public')));
    // The fresh local directory really had zero files. Real catalog/work pages count;
    // the extra one is the local admission accounting item, not a remote lease.
    expect(control.admissionWrites).toBe(graph.files.size + 1);
    expect(uploadPipelineArtifact).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(uploadPipelineArtifact)
        .mock.calls.flatMap(([, files]) => files)
        .some((path) => path.endsWith('cost-profile.json')),
    ).toBe(false);
    await expect(
      validatePartitionPilotPrepared(
        join(root, 'prepared'),
        { ...identity, source: { ...identity.source, sha: 'd'.repeat(40) } },
        2,
      ),
    ).rejects.toThrow('source');
    await writeFile(join(root, 'prepared/cost-profile.json'), '{}', { flag: 'wx' });
    await expect(
      validatePartitionPilotPrepared(join(root, 'prepared'), identity, 2),
    ).rejects.toThrow('default assignment');
    await expect(preparePartitionPilot(context, 2)).rejects.toThrow('fresh empty local namespace');
    expect(uploadPipelineArtifact).toHaveBeenCalledTimes(2);
  });
}, 60000);
