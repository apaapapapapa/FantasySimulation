import { afterEach, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import { pipelineCapacity, pipelinePollMs, pipelineRunners } from './league-pipeline-policy.ts';
import { measuredPipelineProfile } from './league-pipeline-profile.ts';
import { artifactZip } from './test-support/league-zip.ts';
import { archiveHash } from './league-archive.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(['valid', 'source', 'measurement', 'pilot', 'worker'] as const)(
  'authenticates Worker cost profile provenance before admission: %s',
  async (variant) => {
    await withReplayDirectory(async (root) => {
      const { identity, state, fetch } = pipelineActionsFixture();
      const measurementHash = 'sha256:' + 'c'.repeat(64);
      const profile = {
        schemaVersion: 1,
        source: {
          ...identity.source,
          sha: variant === 'source' ? 'd'.repeat(40) : identity.source.sha,
        },
        measurementHash: variant === 'measurement' ? 'sha256:' + 'e'.repeat(64) : measurementHash,
        metric: 'worker-compute-elapsed-ms',
        samples: [
          {
            simulationHash: 'sha256:' + 'f'.repeat(64),
            scenario: 'field',
            characters: ['a', 'b'],
            elapsedMs: 12,
          },
        ],
      };
      Object.assign(state.run, {
        path: '.github/workflows/league-pilot.yml',
        status: 'completed',
        conclusion: 'success',
        head_sha: variant === 'pilot' ? 'b'.repeat(40) : identity.source.sha,
      });
      state.jobs.splice(
        0,
        state.jobs.length,
        ...['produce', 'consume', 'workers'].map((name) => ({ ...state.jobs[0]!, name })),
      );
      if (variant === 'worker') state.jobs[2]!.conclusion = 'failure';
      state.zip = artifactZip('cost-profile.json', Buffer.from(JSON.stringify(profile)));
      Object.assign(state.artifact, {
        name: 'league-123-1-cost-profile',
        digest: archiveHash(state.zip),
        size_in_bytes: state.zip.length,
      });
      const pending = measuredPipelineProfile(
        { root, identity, token: 'test', github: new PipelineArtifacts('test', identity) },
        123,
        measurementHash,
      );
      if (variant === 'valid') await expect(pending).resolves.toEqual(profile);
      else await expect(pending).rejects.toThrow(/mismatch|Untrusted|incomplete/);
      if (variant === 'pilot' || variant === 'worker')
        expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/zip'))).toBe(false);
      expect(state.downloadToken).toBe(false);
    });
  },
);
it('authenticates actual immutable ZIPs, never forwards GitHub credentials and rejects changed bytes', async () => {
  await withReplayDirectory(async (root) => {
    const { identity, state } = pipelineActionsFixture(),
      github = new PipelineArtifacts('private-test-token', identity);
    const [ref] = await github.list();
    await github.download(ref!, join(root, 'good'), (key) => key === 'control.json');
    expect(await readFile(join(root, 'good/control.json'), 'utf8')).toBe('exact bytes');
    expect(state.downloadToken).toBe(false);
    state.zip[40] = state.zip[40]! ^ 1;
    await expect(github.download(ref!, join(root, 'bad'), () => true)).rejects.toThrow('digest');
    expect(await github.successfulProducers(1)).toBe(true);
    state.jobs[1]!.conclusion = 'failure';
    await expect(github.successfulProducers(1)).rejects.toThrow('failed');
  });
});
it.each(['head_sha', 'head_branch', 'path', 'run_attempt'] as const)(
  'rejects foreign %s before downloading producer claims',
  async (field) => {
    const { identity, state, fetch } = pipelineActionsFixture();
    Object.assign(state.run, { [field]: field === 'run_attempt' ? 2 : 'foreign' });
    await expect(new PipelineArtifacts('test', identity).list()).rejects.toThrow('Untrusted');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it('bounds empty metadata polls and requires explicit account approval before scaling', async () => {
  const { identity } = pipelineActionsFixture(),
    github = new PipelineArtifacts('test', identity, 2);
  await github.list();
  await expect(github.list()).rejects.toThrow('budget');
  expect(pipelineRunners('4', undefined)).toBe(4);
  expect(() => pipelineRunners('16', undefined)).toThrow('approval');
  expect(pipelineRunners('16', '16')).toBe(16);
  expect(() =>
    pipelineCapacity(60, [{ partitions: Array.from({ length: 15 }, (_, i) => i) }]),
  ).toThrow('quota');
  expect(pipelinePollMs(300001, 50)).toBe(60000);
});
it('keeps the two-wave DAG, credential boundary, exclusion and current-code-only recovery', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/league-pipeline.yml', import.meta.url),
    'utf8',
  );
  const job = (name: string) => workflow.split(`\n  ${name}:`)[1]!.split(/\n  [a-z]+:/)[0]!;
  expect(job('transfer')).toContain('needs: admit');
  expect(job('transfer')).not.toMatch(/needs:.*compute/);
  expect(job('compute')).not.toMatch(/R2_|secrets\.|environment:/);
  expect(job('compute')).toContain('fetch-depth: 1');
  expect(job('recover')).toContain('ref: ${{ github.sha }}');
  expect(job('recover')).not.toMatch(/league-pipeline.ts (?:compute|admit|prepare|restore)/);
  expect(workflow).toContain('group: r2-publication\n  cancel-in-progress: false');
  expect(workflow).not.toMatch(/pull_request|schedule:|secrets: inherit|permissions: write-all/);
  const secretSteps = workflow.split(/\n      - /).filter((step) => step.includes('secrets.'));
  expect(secretSteps).toHaveLength(4);
  for (const step of secretSteps)
    expect(step).toMatch(/league-pipeline.ts (restore|admit|transfer|recover)/);
  const pilot = readFileSync(
    new URL('../.github/workflows/league-pilot.yml', import.meta.url),
    'utf8',
  );
  expect(pilot).not.toMatch(/R2_|secrets\.|environment:|needs:/);
});
