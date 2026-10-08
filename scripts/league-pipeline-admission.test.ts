import { afterEach, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { restorePipeline } from './league-pipeline-admit.ts';
import { requirePipelineCapacityEvidence } from './league-pipeline-policy.ts';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { openLeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import * as contextPolicy from './league-pipeline-context.ts';
import * as policy from './league-pipeline-policy.ts';
import * as profiles from './league-pipeline-profile.ts';
import { withReplayDirectory } from '@fantasy/api/testing';

vi.mock('../apps/cli/src/league/league-staging.ts', () => ({ openLeagueStaging: vi.fn() }));
vi.mock('./league-pipeline-upload.ts', () => ({ uploadPipelineArtifact: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it('allows small work through CI and profile checks before opening staging', async () => {
  await withReplayDirectory(async (root) => {
    const full = definition();
    vi.spyOn(contextPolicy, 'pipelineDefinition').mockResolvedValue({
      ...full,
      characters: full.characters.slice(0, 2),
      trials: 1,
    });
    const ci = vi.spyOn(policy, 'pipelineCi').mockResolvedValue('a'.repeat(40));
    const profile = vi
      .spyOn(profiles, 'measuredPipelineProfile')
      .mockRejectedValue(new Error('profile probe'));
    const { identity } = pipelineActionsFixture();
    vi.stubEnv('LEAGUE_RUNNERS', '4');
    vi.stubEnv('LEAGUE_PILOT_RUN', '123');
    vi.stubEnv('LEAGUE_COST_PROFILE', 'sha256:' + 'c'.repeat(64));
    const context = {
      root,
      identity,
      token: 'test',
      prefix: 'league-123-1',
      ciRun: 123,
      github: new PipelineArtifacts('test', identity),
    };
    await expect(restorePipeline(context)).rejects.toThrow('profile probe');
    expect(ci).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledOnce();
    expect(openLeagueStaging).not.toHaveBeenCalled();
    profile.mockResolvedValue({
      schemaVersion: 1,
      source: identity.source,
      measurementHash: 'sha256:' + 'c'.repeat(64),
      metric: 'worker-compute-elapsed-ms',
      samples: [
        {
          simulationHash: 'sha256:' + 'd'.repeat(64),
          scenario: 'field',
          characters: ['a', 'b'],
          elapsedMs: 12,
        },
      ],
    });
    vi.spyOn(contextPolicy, 'pipelineR2').mockReturnValue({
      accountId: 'test',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    vi.mocked(openLeagueStaging).mockRejectedValue(new Error('staging probe'));
    await expect(restorePipeline(context)).rejects.toThrow('staging probe');
    expect(openLeagueStaging).toHaveBeenCalledOnce();
  });
});
const definition = () =>
  JSON.parse(
    readFileSync(new URL('../data/leagues/official-20-balanced-v1.json', import.meta.url), 'utf8'),
  );

it('does not confuse small scheduling hints or overlapping compute spans with capacity evidence', () => {
  const full = definition(),
    small = { ...full, characters: full.characters.slice(0, 2), trials: 1 };
  expect(() => requirePipelineCapacityEvidence(small, 4)).not.toThrow();
  // No compute hint, summed inclusive span, or numeric <=270 claim is an authorization input.
  expect(() => requirePipelineCapacityEvidence(full, 4)).toThrow('UNKNOWN');
  expect(() => requirePipelineCapacityEvidence(small, 16)).toThrow('UNKNOWN');
});

it.each(['4', '16'])(
  'holds full-size admission before R2, lease or artifact side effects: %s runners',
  async (runners) => {
    const { identity, fetch } = pipelineActionsFixture();
    vi.stubEnv('LEAGUE_DEFINITION', 'data/leagues/official-20-balanced-v1.json');
    vi.stubEnv('LEAGUE_RUNNERS', runners);
    vi.stubEnv('LEAGUE_APPROVED_RUNNERS', runners);
    const context = {
      root: '.',
      identity,
      token: 'test',
      prefix: 'league-123-1',
      ciRun: 123,
      github: new PipelineArtifacts('test', identity),
    };
    await expect(restorePipeline(context)).rejects.toThrow('UNKNOWN critical path');
    expect(openLeagueStaging).not.toHaveBeenCalled();
    expect(uploadPipelineArtifact).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
