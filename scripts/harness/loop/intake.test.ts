import { expect, it } from 'vite-plus/test';
import type { Gateway, Page } from '../github.ts';
import { collectIntake, INTAKE_REPOSITORY } from './intake.ts';

function fixture() {
  const repo = { id: 1, full_name: INTAKE_REPOSITORY, default_branch: 'main' };
  const sha = 'a'.repeat(40);
  const run = {
    id: 20,
    run_attempt: 1,
    workflow_id: 10,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    repository: repo,
    head_repository: repo,
    status: 'completed',
    conclusion: 'failure',
    updated_at: '2026-09-23T00:00:00Z',
  };
  const event = { action: 'completed', repository: repo, workflow_run: run };
  const jobs = [1, 2].map((id) => ({
    id,
    run_id: 20,
    run_attempt: 1,
    head_sha: sha,
    head_branch: 'main',
    workflow_name: 'CI',
    name: `Source ${id}`,
    status: 'completed',
    conclusion: id === 1 ? 'success' : 'failure',
  }));
  const state = {
    run,
    main: sha,
    jobs,
    omitPage: false,
    reorder: false,
    advance: false,
    calls: 0,
    closed: false,
  };
  const gateway: Gateway = {
    async get(route) {
      state.calls++;
      if (route.endsWith('/branches/main'))
        return { commit: { sha: state.advance && state.calls > 5 ? 'b'.repeat(40) : state.main } };
      if (route.endsWith('/actions/runs/20')) return state.run;
      if (route.endsWith('/actions/workflows/10')) return { id: 10, path: run.path, name: 'CI' };
      if (route === `GET /repos/${INTAKE_REPOSITORY}`) return repo;
      throw new Error('Unexpected request');
    },
    async *pages(route): AsyncIterable<Page> {
      if (route.endsWith('/runs')) {
        yield { data: [state.run], total: 1, next: false };
        return;
      }
      if (!route.endsWith('/jobs')) throw new Error('Unexpected page request');
      const rows = state.reorder ? [...state.jobs].reverse() : state.jobs;
      yield { data: rows.slice(0, 1), total: 2, next: true };
      if (!state.omitPage) yield { data: rows.slice(1), total: 2, next: false };
    },
    async query() {
      throw new Error('No GraphQL or writes in intake');
    },
    close() {
      state.closed = true;
    },
  };
  return { event, gateway, state };
}
it('reads every page and generates stable deduplicatable IDs regardless of event/job order', async () => {
  const f = fixture();
  const first = await collectIntake(f.gateway, f.event);
  expect(first).toMatchObject({ status: 'proposed', repaired: false, stage: 'proposal' });
  expect(first.candidates).toHaveLength(1);
  expect(f.state.closed).toBe(true);
  f.state.reorder = true;
  const again = await collectIntake(f.gateway, f.event);
  expect(again.candidates).toEqual(first.candidates);
});
it.each([
  'fork',
  'branch',
  'event',
  'workflow',
  'missing-page',
  'wrong-job',
  'duplicate-job',
  'moving-head',
])('keeps %s evidence incomplete', async (problem) => {
  const f = fixture();
  switch (problem) {
    case 'fork':
      f.event.workflow_run.head_repository = { ...f.event.repository, full_name: 'external/fork' };
      break;
    case 'branch':
      f.event.workflow_run.head_branch = 'loop/task';
      break;
    case 'event':
      f.event.workflow_run.event = 'pull_request';
      break;
    case 'workflow':
      f.event.workflow_run.path = '.github/workflows/other.yml';
      break;
    case 'missing-page':
      f.state.omitPage = true;
      break;
    case 'wrong-job':
      f.state.jobs[1]!.head_sha = 'b'.repeat(40);
      break;
    case 'duplicate-job':
      f.state.jobs[1]!.id = 1;
      break;
    case 'moving-head':
      f.state.advance = true;
      break;
  }
  expect(await collectIntake(f.gateway, f.event)).toMatchObject({
    status: 'unknown',
    candidates: [],
    repaired: false,
  });
});
it.each(['new-main', 'rerun', 'success'])(
  'does not adopt a historical failure after %s',
  async (reason) => {
    const f = fixture();
    if (reason === 'new-main') f.state.main = 'b'.repeat(40);
    else
      f.state.run = {
        ...f.state.run,
        run_attempt: 2,
        conclusion: reason === 'success' ? 'success' : 'failure',
      };
    expect(await collectIntake(f.gateway, f.event)).toMatchObject({
      status: 'superseded',
      candidates: [],
      repaired: false,
    });
  },
);
