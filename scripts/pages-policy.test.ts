import { expect, it } from 'vite-plus/test';
import { pagesSource } from './pages-policy.ts';

it('rejects fork/PR, stale automatic runs, failed CI and a gate from another commit', () => {
  const sha = 'b'.repeat(40);
  const run = {
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: 'apaapapapapa/FantasySimulation' },
  };
  const jobs = [{ name: 'ci-gate', status: 'completed', conclusion: 'success', head_sha: sha }];
  expect(pagesSource(run, jobs, sha, false, 'identical')).toBe(sha);
  for (const change of [
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { conclusion: 'failure' },
    { head_repository: { full_name: 'someone/FantasySimulation' } },
    { path: '.github/workflows/security.yml' },
  ])
    expect(() => pagesSource({ ...run, ...change }, jobs, sha, false, 'identical')).toThrow();
  expect(() => pagesSource(run, jobs, 'c'.repeat(40), false, 'ahead')).toThrow();
  expect(() =>
    pagesSource(run, [{ ...jobs[0]!, head_sha: 'c'.repeat(40) }], sha, false, 'identical'),
  ).toThrow();
  expect(() => pagesSource(run, [], sha, false, 'identical')).toThrow();
  expect(pagesSource(run, jobs, 'c'.repeat(40), true, 'ahead')).toBe(sha);
  expect(() => pagesSource(run, jobs, 'c'.repeat(40), true, 'diverged')).toThrow();
});
