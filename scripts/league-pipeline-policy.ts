import { leagueSource } from './pages-policy.ts';
import type { PipelineArtifacts } from './league-pipeline-artifacts.ts';

export function pipelineCapacity(
  partitions: number,
  assignments: readonly { partitions: number[] }[],
) {
  // Each producer may upload three bounded parts per partition, plus one terminal.
  if (
    assignments.some((assignment) => assignment.partitions.length * 3 + 2 > 32) ||
    partitions * 3 + assignments.length * 2 + 5 > 256
  )
    throw new Error('Preflight artifact quota requires more approved runners or a smaller league');
}
export function pipelineRunners(value: string | undefined, approval: string | undefined) {
  const runners = Number(value);
  if (
    !Number.isInteger(runners) ||
    runners < 1 ||
    runners > 32 ||
    (runners > 4 && approval !== String(runners))
  )
    throw new Error(
      'Runner count requires measured critical path and explicit account-capacity approval',
    );
  return runners;
}
export function pipelinePollMs(elapsed: number, polls: number) {
  return elapsed >= 300000 ? 60000 : ([1000, 2000, 4000, 8000][polls] ?? 15000);
}
export async function pipelineCi(
  github: PipelineArtifacts,
  runId: number,
  phase: 'start' | 'finish',
) {
  const run = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
    run_id: runId,
  });
  const jobs = await github.request(
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    {
      run_id: runId,
      attempt_number: run.run_attempt,
      per_page: 100,
    },
  );
  if (jobs.total_count > 100 || jobs.jobs.length !== jobs.total_count)
    throw new Error('Incomplete source CI jobs');
  const main = await github.request('GET /repos/{owner}/{repo}/branches/{branch}', {
    branch: 'main',
  });
  const comparison =
    phase === 'finish'
      ? await github.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
          base: github.identity.source.sha,
          head: main.commit.sha,
        })
      : { status: 'identical' };
  return leagueSource(
    run,
    jobs.jobs,
    main.commit.sha,
    github.identity.source.sha,
    phase,
    comparison.status,
  );
}
export async function requireArtifactPilot(github: PipelineArtifacts, runId: number) {
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error('Successful same-source artifact pilot required');
  const run = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
    run_id: runId,
  });
  if (
    run.path !== '.github/workflows/league-pilot.yml' ||
    run.head_sha !== github.identity.source.sha ||
    run.head_branch !== 'main' ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_repository?.full_name !== 'apaapapapapa/FantasySimulation'
  )
    throw new Error('Untrusted artifact pilot');
  const jobs = await github.request(
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    {
      run_id: runId,
      attempt_number: run.run_attempt,
      per_page: 100,
    },
  );
  if (
    jobs.jobs.length !== jobs.total_count ||
    ['produce', 'consume'].some(
      (name) =>
        jobs.jobs.filter(
          (job: { name: string; conclusion: string }) =>
            job.name === name && job.conclusion === 'success',
        ).length !== 1,
    )
  )
    throw new Error('Artifact visibility/quota pilot incomplete');
}
