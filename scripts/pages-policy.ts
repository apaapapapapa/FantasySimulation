/** Pure gate shared by build/deploy; API reads must be fresh at each boundary. */
export function pagesSource(
  run: {
    path: string;
    event: string;
    head_branch: string | null;
    head_sha: string;
    status: string | null;
    conclusion: string | null;
    head_repository: { full_name: string } | null;
  },
  jobs: { name: string; status: string; conclusion: string | null; head_sha: string }[],
  mainSha: string,
  manual: boolean,
  comparison: string,
) {
  if (
    run.path !== '.github/workflows/ci.yml' ||
    run.event !== 'push' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== 'apaapapapapa/FantasySimulation' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    (!manual && run.head_sha !== mainSha) ||
    (manual && !['ahead', 'identical'].includes(comparison)) ||
    jobs.filter(
      (job) =>
        job.name === 'ci-gate' &&
        job.status === 'completed' &&
        job.conclusion === 'success' &&
        job.head_sha === run.head_sha,
    ).length !== 1
  )
    throw new Error('Pages requires a successful main CI and current ci-gate at the requested SHA');
  return run.head_sha;
}
