import { expect, it } from 'vite-plus/test';
import {
  leagueArtifact,
  leagueRecoverySource,
  assertRecoveryCatalog,
  leagueArtifactTimeout,
} from './league-artifact-policy.ts';

it('bounds full recovery separately without extending artifact transfer deadlines', () => {
  expect(leagueArtifactTimeout('recover')).toBe(5_400_000);
  for (const operation of ['prepare', 'input', 'result', 'aggregate'])
    expect(leagueArtifactTimeout(operation)).toBe(3_600_000);
  for (const operation of [undefined, null, 5400000, '', 'Recover', 'run', 'publish'])
    expect(() => leagueArtifactTimeout(operation)).toThrow('Unknown');
});

it('blocks recovery when the newly validated catalog differs from original completion evidence', () => {
  const hash = 'sha256:' + 'a'.repeat(64);
  expect(() => assertRecoveryCatalog({ catalogHash: hash }, hash)).not.toThrow();
  for (const original of [
    null,
    {},
    { catalogHash: 'sha256:' + 'b'.repeat(64) },
    { catalogHash: 0 },
  ])
    expect(() => assertRecoveryCatalog(original, hash)).toThrow('differs');
});

it('accepts only the exact failed main publication with completed successful workers', () => {
  const run = {
    id: 123,
    run_attempt: 1,
    path: '.github/workflows/league.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'failure',
    head_repository: { full_name: 'apaapapapapa/FantasySimulation' },
  };
  const jobs = ['prepare', 'compute (0)', 'publish'].map((name) => ({
    name,
    status: 'completed',
    conclusion: name === 'publish' ? 'failure' : 'success',
    head_sha: run.head_sha,
  }));
  const expected = { runId: 123, attempt: 1 };
  expect(leagueRecoverySource(run, jobs, expected)).toBe(run.head_sha);
  for (const change of [
    { id: 124 },
    { run_attempt: 2 },
    { path: '.github/workflows/other.yml' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { status: 'in_progress' },
    { conclusion: 'success' },
    { head_repository: { full_name: 'fork/FantasySimulation' } },
  ])
    expect(() => leagueRecoverySource({ ...run, ...change }, jobs, expected)).toThrow();
  for (const change of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { status: 'in_progress' },
    { head_sha: 'b'.repeat(40) },
    { name: 'unknown' },
  ])
    expect(() =>
      leagueRecoverySource(run, [jobs[0]!, { ...jobs[1]!, ...change }, jobs[2]!], expected),
    ).toThrow();
  expect(() => leagueRecoverySource(run, [...jobs, jobs[0]!], expected)).toThrow();
  expect(() =>
    leagueRecoverySource(run, [...jobs, { ...jobs[0]!, conclusion: 'failure' }], expected),
  ).toThrow();
});
it('binds each download to the current run/attempt name, immutable ID and digest', () => {
  const name = 'league-123-2-input-0',
    digest = 'a'.repeat(64);
  const ref = { id: 1234, name, size: 100, digest };
  expect(leagueArtifact([ref], name, { id: 1234, digest: 'sha256:' + digest })).toEqual({
    id: 1234,
    digest: 'sha256:' + digest,
  });
  for (const entries of [
    [],
    [ref, ref],
    [{ ...ref, name: 'league-123-1-input-0' }],
    [{ ...ref, digest: '' }],
    [{ ...ref, size: 8100000001 }],
  ])
    expect(() => leagueArtifact(entries, name)).toThrow();
  expect(() => leagueArtifact([ref], name, { id: 5678, digest })).toThrow('identity');
  expect(() => leagueArtifact([ref], name, { id: 1234, digest: 'b'.repeat(64) })).toThrow(
    'identity',
  );
});
