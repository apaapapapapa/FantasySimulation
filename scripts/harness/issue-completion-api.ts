import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessReport, record, sha } from './report.ts';
import type { Check, Report } from './report.ts';
import {
  bodyDigest,
  completedBody,
  completionMarker,
  parseCompletion,
  positiveInteger,
  repository,
  requireCompletion,
  validateJobs,
  validateRun,
  validateSource,
} from './issue-completion.ts';
import type { Completion } from './issue-completion.ts';

export type Api = (method: 'GET' | 'PATCH', path: string, body?: unknown) => Promise<unknown>;

export function githubApi(token: string): Api {
  requireCompletion(token.length > 0, 'GITHUB_TOKEN_REQUIRED');
  return async (method, path, body) => {
    requireCompletion(path.startsWith('/'), 'INVALID_API_PATH');
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    requireCompletion(response.ok, `GITHUB_HTTP_${response.status}`);
    requireCompletion(response.body, 'EMPTY_GITHUB_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('GITHUB_RESPONSE_TOO_LARGE');
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
}

export async function collection(api: Api, path: string, key: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = record(await api('GET', `${path}?per_page=100&page=${page}`));
    const entries = result[key];
    requireCompletion(Array.isArray(entries), 'INVALID_COLLECTION');
    values.push(...entries);
    if (entries.length < 100) {
      requireCompletion(result.total_count === values.length, 'INCOMPLETE_COLLECTION');
      return values;
    }
  }
  throw new Error('COLLECTION_TOO_LARGE');
}

function validateIssue(issue: Record<string, unknown>, plan: Completion): string {
  requireCompletion(issue.number === plan.issue && !issue.pull_request, 'NOT_TARGET_ISSUE');
  requireCompletion(issue.state === 'open' && typeof issue.body === 'string', 'ISSUE_NOT_OPEN');
  requireCompletion(
    bodyDigest(issue.body) === plan.issueBodySha256 && issue.updated_at === plan.issueUpdatedAt,
    'ISSUE_CHANGED_SINCE_REVIEW',
  );
  if (issue.sub_issues_summary !== undefined) {
    const children = record(issue.sub_issues_summary);
    requireCompletion(
      Number.isSafeInteger(children.total) && children.total === children.completed,
      'OPEN_SUB_ISSUES',
    );
  }
  return issue.body;
}

export async function completeOne(
  api: Api,
  plan: Completion,
  sourceSha: string,
  runId: number,
  apply: boolean,
): Promise<string> {
  const path = `/issues/${plan.issue}`;
  const issue = record(await api('GET', path));
  requireCompletion(issue.number === plan.issue && !issue.pull_request, 'NOT_TARGET_ISSUE');
  if (issue.state === 'closed') return 'ALREADY_CLOSED';
  if (typeof issue.body === 'string' && issue.body.includes(completionMarker))
    return 'PREVIOUSLY_COMPLETED_DO_NOT_RECLOSE';
  const body = validateIssue(issue, plan);
  const updated = completedBody(plan, body, sourceSha, runId);
  for (const number of plan.pullRequests) {
    const pr = record(await api('GET', `/pulls/${number}`));
    const base = record(pr.base);
    requireCompletion(
      pr.number === number &&
        pr.merged === true &&
        base.ref === 'main' &&
        record(base.repo).full_name === repository,
      'PR_NOT_MERGED_TO_MAIN',
    );
    const merged = sha(pr.merge_commit_sha);
    const comparison = record(await api('GET', `/compare/${merged}...${sourceSha}`));
    requireCompletion(
      comparison.status === 'ahead' || comparison.status === 'identical',
      'PR_NOT_IN_VERIFIED_MAIN',
    );
  }
  const current = record(await api('GET', '/git/ref/heads/main'));
  requireCompletion(record(current.object).sha === sourceSha, 'MAIN_ADVANCED_REVERIFY');
  // Re-read immediately before the single body+state PATCH. GitHub Issues has no atomic CAS API.
  const fresh = record(await api('GET', path));
  validateIssue(fresh, plan);
  if (!apply) return 'DRY_RUN_WOULD_CLOSE';
  const response = record(
    await api('PATCH', path, { body: updated, state: 'closed', state_reason: 'completed' }),
  );
  requireCompletion(
    response.number === plan.issue &&
      response.body === updated &&
      response.state === 'closed' &&
      response.state_reason === 'completed',
    'ISSUE_UPDATE_NOT_CONFIRMED',
  );
  const persisted = record(await api('GET', path));
  requireCompletion(
    persisted.body === updated && persisted.state === 'closed' && persisted.state_reason === 'completed',
    'ISSUE_COMPLETION_NOT_PERSISTED',
  );
  return 'UPDATED_AND_CLOSED';
}

function readJson(path: string): unknown {
  requireCompletion(statSync(path).isFile() && statSync(path).size <= 8 * 1024 * 1024, 'INVALID_FILE');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export async function completeIssues(evidenceDirectory: string, apply: boolean) {
  requireCompletion(process.env.GITHUB_REPOSITORY === repository, 'WRONG_REPOSITORY');
  requireCompletion(process.env.GITHUB_EVENT_NAME === 'workflow_run', 'WORKFLOW_RUN_REQUIRED');
  const event = record(readJson(process.env.GITHUB_EVENT_PATH ?? ''));
  const trigger = record(event.workflow_run);
  const sourceSha = sha(trigger.head_sha);
  const attempt = positiveInteger(trigger.run_attempt);
  const runId = validateRun(trigger, sourceSha, attempt);
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireCompletion(checkedOut === sourceSha, 'CHECKOUT_NOT_VERIFIED_MAIN');
  const api = githubApi(process.env.GITHUB_TOKEN ?? '');
  requireCompletion(
    validateRun(await api('GET', `/actions/runs/${runId}`), sourceSha, attempt) === runId,
    'RUN_ID_MISMATCH',
  );
  validateJobs(await collection(api, `/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs'));
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    const directory = join(evidenceDirectory, `harness-${os}`, 'source');
    validateSource(readJson(join(directory, 'report.json')), readJson(join(directory, 'command.json')), sourceSha);
  }
  const directory = '.github/issue-completions';
  const files = readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
  requireCompletion(files.length <= 100, 'TOO_MANY_COMPLETIONS');
  const plans = files.map((file) => {
    const plan = parseCompletion(readJson(join(directory, file)));
    requireCompletion(file === `${plan.issue}.json`, 'COMPLETION_FILENAME_MISMATCH');
    return plan;
  });
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  for (const plan of plans) {
    let status: Check['status'] = 'pass';
    let reason: string;
    try {
      reason = await completeOne(api, plan, sourceSha, runId, apply);
    } catch (error) {
      status = 'unknown';
      reason = error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
        ? error.message : 'ISSUE_COMPLETION_FAILED';
    }
    checks.push({
      id: `issue-${plan.issue}`,
      required: true,
      status,
      reason,
      evidence: [{ uri: `https://github.com/${repository}/issues/${plan.issue}`, sourceSha }],
    });
  }
  if (!checks.length) checks.push({
    id: 'issues-none', required: true, status: 'pass', reason: 'NO_COMPLETION_DECLARATIONS',
    evidence: [{ uri: `https://github.com/${repository}/actions/runs/${runId}`, sourceSha }],
  });
  const report: Report = {
    schemaVersion: 1, producer: 'issue-completion', sourceSha, candidateSha: sourceSha,
    baselineSha: null, testMergeSha: null, startedAt, finishedAt: new Date().toISOString(), checks,
  };
  const result = assessReport(report, checks.map((check) => check.id));
  mkdirSync('.generated/harness/issues', { recursive: true });
  writeFileSync('.generated/harness/issues/report.json', `${JSON.stringify(result.report, null, 2)}\n`);
  return result;
}

export async function completionDraft(issue: number) {
  const { issueTasks } = await import('./issue-completion.ts');
  const api = githubApi(process.env.GITHUB_TOKEN ?? '');
  const current = record(await api('GET', `/issues/${positiveInteger(issue)}`));
  requireCompletion(!current.pull_request && current.state === 'open', 'ISSUE_NOT_OPEN');
  requireCompletion(typeof current.body === 'string', 'ISSUE_BODY_REQUIRED');
  return {
    schemaVersion: 1, issue, issueBodySha256: bodyDigest(current.body),
    issueUpdatedAt: current.updated_at, complete: false, summary: '',
    remainingWork: ['Review the full Issue scope and provide evidence for every acceptance item.'],
    pullRequests: [],
    acceptance: issueTasks(current.body).map((entry) => ({ task: entry.task, evidence: '' })),
  };
}
