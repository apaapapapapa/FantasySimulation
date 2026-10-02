import { afterEach, expect, it, vi } from 'vite-plus/test';
import { computeRunnerCalibrationPipeline } from './league-pipeline-compute.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import * as runner from '../apps/cli/src/league/league-runner.ts';
import * as upload from './league-calibration-upload.ts';

afterEach(() => vi.restoreAllMocks());

it.each([30, 40])(
  'rejects a %i-minute-old authenticated calibration run before download, upload or simulation',
  async (age) => {
    const fixture = pipelineActionsFixture();
    const github = new PipelineArtifacts(
      'fixture',
      fixture.identity,
      20,
      'league-runner-calibration.yml',
    );
    const createdAt = new Date(Date.now() - age * 60000).toISOString();
    vi.spyOn(github, 'request').mockResolvedValue({
      id: fixture.identity.runId,
      run_attempt: fixture.identity.runAttempt,
      head_sha: fixture.identity.source.sha,
      head_branch: 'main',
      event: 'workflow_dispatch',
      path: '.github/workflows/league-runner-calibration.yml',
      head_repository: { full_name: 'apaapapapapa/FantasySimulation' },
      created_at: createdAt,
    });
    const download = vi.spyOn(github, 'download');
    const list = vi.spyOn(github, 'list');
    const compute = vi.spyOn(runner, 'runCloudLeagueRunner');
    const allocation = vi.spyOn(upload, 'uploadCalibrationArtifact');
    const admission = vi.fn(async () => {});
    await expect(
      computeRunnerCalibrationPipeline(
        'unused',
        github,
        fixture.identity,
        0,
        new AbortController().signal,
        admission,
      ),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
    expect(allocation).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  },
);
