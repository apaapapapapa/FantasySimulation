import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { collection, completeOne } from '../harness/issue-completion-api.ts';
import type { Api } from '../harness/issue-completion-api.ts';
import {
  bodyDigest,
  completedBody,
  completionMarker,
  issueTasks,
  parseCompletion,
  repository,
  requiredJobs,
  validateJobs,
  validateRun,
  validateSource,
} from '../harness/issue-completion.ts';

const sourceSha = 'a'.repeat(40);
const mergedSha = 'b'.repeat(40);
const body = '## Acceptance\n\n- [ ] Implementation\n- [ ] External setup\n';
const updatedAt = '2026-09-22T00:00:00Z';
function declaration() {
  return {
    schemaVersion: 1,
    issue: 25,
    issueBodySha256: bodyDigest(body),
    issueUpdatedAt: updatedAt,
    complete: true,
    summary: 'Implemented and verified the complete Issue scope.',
    remainingWork: [],
    pullRequests: [26],
    acceptance: [
      { task: 'Implementation', evidence: 'Implementation regression tests passed.' },
      { task: 'External setup', evidence: 'Explicitly verified the required external setup.' },
    ],
  };
}
function run() {
  return {
    id: 100, name: 'CI', path: '.github/workflows/ci.yml', head_branch: 'main',
    head_sha: sourceSha, event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1,
    repository: { full_name: repository }, head_repository: { full_name: repository },
  };
}
function source() {
  return {
    schemaVersion: 1, producer: 'source-runner', sourceSha, candidateSha: sourceSha,
    baselineSha: null, testMergeSha: null, startedAt: updatedAt, finishedAt: updatedAt,
    checks: ['source-clean', 'source-verify'].map((id) => ({
      id, required: true, status: 'pass', reason: 'verified',
      evidence: [{ uri: '.generated/harness/source/command.json', sourceSha }],
    })),
  };
}
const command = {
  sourceSha, command: ['vp', 'run', 'verify'], exitCode: 0, signal: null,
  bounded: false, cleanBefore: true, cleanAfter: true,
};
function fake() {
  const state = {
    issue: { number: 25, body, updated_at: updatedAt, state: 'open', state_reason: null as string | null },
    pr: { number: 26, merged: true, merge_commit_sha: mergedSha, base: { ref: 'main', repo: { full_name: repository } } },
    main: sourceSha, comparison: 'ahead', writes: [] as unknown[], reads: 0, editOnSecondRead: false,
    rejectWrite: false,
  };
  const api: Api = async (method, path, payload) => {
    if (method === 'PATCH') {
      assert.equal(path, '/issues/25');
      if (state.rejectWrite) throw new Error('GITHUB_HTTP_403');
      state.writes.push(payload);
      Object.assign(state.issue, payload);
      return structuredClone(state.issue);
    }
    if (path === '/issues/25') {
      state.reads++;
      if (state.editOnSecondRead && state.reads === 2) state.issue.body += '\nNew blocker';
      return structuredClone(state.issue);
    }
    if (path === '/pulls/26') return state.pr;
    if (path === `/compare/${mergedSha}...${sourceSha}`) return { status: state.comparison };
    if (path === '/git/ref/heads/main') return { object: { sha: state.main } };
    throw new Error('UNEXPECTED_API_CALL');
  };
  return { state, api };
}

await test('complete declaration requires all acceptance evidence and no remaining work', () => {
  assert.equal(parseCompletion(declaration()).issue, 25);
  for (const change of [
    { complete: false }, { remainingWork: ['App authorization pending'] }, { remainingWork: undefined },
    { acceptance: [] }, { acceptance: [{ task: 'test', evidence: '' }] },
    { pullRequests: [] }, { pullRequests: [26, 26] }, { issue: -1 },
    { issueBodySha256: 'short' }, { issueUpdatedAt: '2026-02-30T00:00:00Z' },
  ]) assert.throws(() => parseCompletion({ ...declaration(), ...change }));
});

await test('only successful same-repository main CI at the exact SHA and attempt is accepted', () => {
  assert.equal(validateRun(run(), sourceSha, 1), 100);
  for (const change of [
    { event: 'pull_request' }, { head_branch: 'feature' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { head_sha: mergedSha }, { path: '.github/workflows/unrelated.yml' }, { name: 'Other' },
    { head_repository: { full_name: 'attacker/fork' } }, { run_attempt: 2 },
  ]) assert.throws(() => validateRun({ ...run(), ...change }, sourceSha, 1));
});

await test('all required jobs must be present once and successful; a green aggregate alone is insufficient', () => {
  const jobs = requiredJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  validateJobs(jobs);
  assert.throws(() => validateJobs(jobs.slice(1)));
  assert.throws(() => validateJobs([...jobs, jobs[0]]));
  for (const conclusion of ['skipped', 'failure', 'cancelled', null])
    assert.throws(() => validateJobs([...jobs.slice(1), { ...jobs[0], conclusion }]));
});

await test('shared source report and command must describe a clean successful verify of main', () => {
  validateSource(source(), command, sourceSha);
  for (const change of [{ sourceSha: mergedSha }, { testMergeSha: sourceSha, baselineSha: mergedSha }, { checks: [] }])
    assert.throws(() => validateSource({ ...source(), ...change }, command, sourceSha));
  const stale = source();
  stale.checks[0]!.evidence[0]!.sourceSha = mergedSha;
  assert.throws(() => validateSource(stale, command, sourceSha));
  for (const change of [{ exitCode: 1 }, { bounded: true }, { cleanAfter: false }, { command: ['echo', 'pass'] }])
    assert.throws(() => validateSource(source(), { ...command, ...change }, sourceSha));
});

await test('checklist updates require complete exact coverage including external acceptance', () => {
  const plan = parseCompletion(declaration());
  const result = completedBody(plan, body, sourceSha, 100);
  assert.ok(result.startsWith(body.replaceAll('[ ]', '[x]')));
  assert.ok(result.includes(completionMarker));
  assert.ok(result.includes(`/commit/${sourceSha}`));
  assert.ok(result.includes('/actions/runs/100'));
  assert.ok(result.includes('/pull/26'));
  assert.throws(() => completedBody({ ...plan, acceptance: plan.acceptance.slice(1) }, body, sourceSha, 100));
  assert.throws(() => completedBody(plan, `${body}- [ ] New requirement\n`, sourceSha, 100));
  assert.throws(() => completedBody(plan, `${body}- [ ] Implementation\n`, sourceSha, 100));
});

await test('fenced examples and HTML comments are not checked off as real tasks', () => {
  const example = '```md\n- [ ] Example\n```\n<!--\n- [ ] Hidden\n-->\n';
  assert.deepEqual(issueTasks(example + body).map((entry) => entry.task), ['Implementation', 'External setup']);
  assert.ok(completedBody(parseCompletion(declaration()), example + body, sourceSha, 100).includes('- [ ] Example'));
  assert.throws(() => issueTasks('```\n- [ ] Unclosed'));
});

await test('a verified completion updates body and state in one request and verifies persistence', async () => {
  const { api, state } = fake();
  assert.equal(await completeOne(api, parseCompletion(declaration()), sourceSha, 100, true), 'UPDATED_AND_CLOSED');
  assert.equal(state.writes.length, 1);
  assert.equal(state.issue.state_reason, 'completed');
  assert.equal(state.issue.state, 'closed');
  assert.ok(state.issue.body.includes(completionMarker));
  assert.equal(state.reads, 3);
  assert.equal(await completeOne(api, parseCompletion(declaration()), sourceSha, 100, true), 'ALREADY_CLOSED');
  assert.equal(state.writes.length, 1);
});

await test('dry-run never writes and reopening after completion is respected', async () => {
  const { api, state } = fake();
  assert.equal(await completeOne(api, parseCompletion(declaration()), sourceSha, 100, false), 'DRY_RUN_WOULD_CLOSE');
  assert.equal(state.writes.length, 0);
  state.issue.body += completionMarker;
  assert.equal(await completeOne(api, parseCompletion(declaration()), sourceSha, 100, true), 'PREVIOUSLY_COMPLETED_DO_NOT_RECLOSE');
  assert.equal(state.writes.length, 0);
});

await test('changed Issue body or activity, newer main, unmerged PR and unverified merge all block writes', async () => {
  for (const scenario of ['body', 'activity', 'main', 'unmerged', 'branch', 'ancestry', 'concurrent', 'pr']) {
    const { api, state } = fake();
    if (scenario === 'body') state.issue.body += '\nBlocked';
    if (scenario === 'activity') state.issue.updated_at = '2026-09-22T01:00:00Z';
    if (scenario === 'main') state.main = mergedSha;
    if (scenario === 'unmerged') state.pr.merged = false;
    if (scenario === 'branch') state.pr.base.ref = 'feature';
    if (scenario === 'ancestry') state.comparison = 'diverged';
    if (scenario === 'concurrent') state.editOnSecondRead = true;
    if (scenario === 'pr') Object.assign(state.issue, { pull_request: {} });
    await assert.rejects(() => completeOne(api, parseCompletion(declaration()), sourceSha, 100, true));
    assert.equal(state.writes.length, 0);
  }
});

await test('open sub-issues and rejected writes cannot become completion success', async () => {
  const fixture = fake();
  Object.assign(fixture.state.issue, { sub_issues_summary: { total: 2, completed: 1 } });
  await assert.rejects(() => completeOne(fixture.api, parseCompletion(declaration()), sourceSha, 100, true), /OPEN_SUB_ISSUES/);
  assert.equal(fixture.state.writes.length, 0);
  const denied = fake();
  denied.state.rejectWrite = true;
  await assert.rejects(() => completeOne(denied.api, parseCompletion(declaration()), sourceSha, 100, true), /403/);
  assert.equal(denied.state.issue.state, 'open');
});

await test('job pagination does not silently discard later checks or accept truncated results', async () => {
  const api: Api = async (_method, path) => ({
    total_count: 101,
    jobs: path.endsWith('page=1') ? Array.from({ length: 100 }, () => ({})) : [{}],
  });
  assert.equal((await collection(api, '/jobs', 'jobs')).length, 101);
  await assert.rejects(() => collection(async () => ({ total_count: 3, jobs: [{}] }), '/jobs', 'jobs'));
});

await test('committed completion declarations are explicit and uniquely named', () => {
  const directory = new URL('../../.github/issue-completions/', import.meta.url);
  for (const file of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
    const plan = parseCompletion(JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as unknown);
    assert.equal(file, `${plan.issue}.json`);
  }
});

await test('writer workflow is isolated from PRs and bound to the successful main run', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/issue-completion.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('workflow_run:'));
  assert.ok(workflow.includes("github.event.workflow_run.head_repository.full_name == github.repository"));
  assert.ok(workflow.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(workflow.includes('ref: ${{ github.event.workflow_run.head_sha }}'));
  assert.ok(workflow.includes('run-id: ${{ github.event.workflow_run.id }}'));
  assert.ok(workflow.includes('issues: write'));
  assert.ok(!workflow.includes('pull_request_target'));
  assert.ok(!workflow.includes('contents: write'));
  assert.ok(!workflow.includes('vp install'));
});
