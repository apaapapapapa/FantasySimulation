import { createHash } from 'node:crypto';
import { assessReport, record, sha, text, timestamp } from './report.ts';

export const repository = 'apaapapapapa/FantasySimulation';
export const completionMarker = '<!-- harness:issue-completed:v1 -->';
export const requiredJobs = [
  'Verify (ubuntu-latest)',
  'Verify (windows-latest)',
  'Security / Secret scan',
  'Security / Dependency audit',
  'Security / CodeQL and severity policy',
  'Security / security-gate',
  'Dependency policy / Renovate configuration',
  'Dependency policy / Toolchain policy (ubuntu-latest)',
  'Dependency policy / Toolchain policy (windows-latest)',
  'Dependency policy / dependency-policy-gate',
  'Release',
];

export interface Completion {
  schemaVersion: 1;
  issue: number;
  issueBodySha256: string;
  issueUpdatedAt: string;
  complete: true;
  summary: string;
  remainingWork: string[];
  pullRequests: number[];
  acceptance: { task: string; evidence: string }[];
}

export function requireCompletion(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

export function positiveInteger(value: unknown): number {
  requireCompletion(Number.isSafeInteger(value) && Number(value) > 0, 'INVALID_NUMBER');
  return Number(value);
}

export function bodyDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function parseCompletion(value: unknown): Completion {
  const obj = record(value);
  requireCompletion(obj.schemaVersion === 1 && obj.complete === true, 'INCOMPLETE_DECLARATION');
  requireCompletion(
    Array.isArray(obj.remainingWork) && obj.remainingWork.length === 0,
    'REMAINING_WORK',
  );
  requireCompletion(
    Array.isArray(obj.pullRequests) && obj.pullRequests.length > 0 && obj.pullRequests.length <= 20,
    'PULL_REQUESTS_REQUIRED',
  );
  const pullRequests = obj.pullRequests.map(positiveInteger);
  requireCompletion(new Set(pullRequests).size === pullRequests.length, 'DUPLICATE_PR');
  const issueBodySha256 = text(obj.issueBodySha256);
  requireCompletion(/^[a-f0-9]{64}$/.test(issueBodySha256), 'INVALID_BODY_DIGEST');
  timestamp(obj.issueUpdatedAt);
  requireCompletion(
    Array.isArray(obj.acceptance) && obj.acceptance.length > 0 && obj.acceptance.length <= 500,
    'ACCEPTANCE_REQUIRED',
  );
  const acceptance = obj.acceptance.map((item: unknown) => {
    const entry = record(item);
    const task = text(entry.task).trim();
    const evidence = text(entry.evidence).trim();
    requireCompletion(
      task.length <= 2000 && evidence.length >= 10 && evidence.length <= 2000,
      'INVALID_ACCEPTANCE',
    );
    return { task, evidence };
  });
  requireCompletion(
    new Set(acceptance.map((entry) => entry.task)).size === acceptance.length,
    'DUPLICATE_ACCEPTANCE',
  );
  const summary = text(obj.summary).trim();
  requireCompletion(summary.length <= 2000, 'SUMMARY_TOO_LONG');
  return {
    schemaVersion: 1,
    issue: positiveInteger(obj.issue),
    issueBodySha256,
    issueUpdatedAt: text(obj.issueUpdatedAt),
    complete: true,
    summary,
    remainingWork: [],
    pullRequests,
    acceptance,
  };
}

export function validateRun(value: unknown, expectedSha: string, expectedAttempt: number): number {
  const run = record(value);
  requireCompletion(
    run.name === 'CI' &&
      run.path === '.github/workflows/ci.yml' &&
      run.head_branch === 'main' &&
      (run.event === 'push' || run.event === 'workflow_dispatch') &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_sha === sha(expectedSha) &&
      run.run_attempt === expectedAttempt &&
      record(run.repository).full_name === repository &&
      record(run.head_repository).full_name === repository,
    'UNTRUSTED_OR_UNSUCCESSFUL_MAIN_RUN',
  );
  return positiveInteger(run.id);
}

export function validateJobs(values: unknown[]): void {
  const jobs = values.map(record);
  for (const name of requiredJobs) {
    const matching = jobs.filter((job) => job.name === name);
    requireCompletion(matching.length === 1, 'MISSING_OR_DUPLICATE_REQUIRED_JOB');
  }
  requireCompletion(
    jobs.every((job) => job.status === 'completed' && job.conclusion === 'success'),
    'FAILED_OR_SKIPPED_JOB',
  );
}

export function validateSource(value: unknown, commandValue: unknown, sourceSha: string): void {
  const result = assessReport(value, ['source-clean', 'source-verify']);
  const report = result.report;
  requireCompletion(
    result.exitCode === 0 &&
      report.producer === 'source-runner' &&
      report.sourceSha === sourceSha &&
      report.candidateSha === sourceSha &&
      report.testMergeSha === null,
    'INVALID_SOURCE_EVIDENCE',
  );
  const command = record(commandValue);
  requireCompletion(
    command.sourceSha === sourceSha &&
      JSON.stringify(command.command) === JSON.stringify(['vp', 'run', 'verify']) &&
      command.exitCode === 0 &&
      command.signal === null &&
      command.bounded === false &&
      command.cleanBefore === true &&
      command.cleanAfter === true,
    'INVALID_VERIFY_COMMAND',
  );
}

// Ignore fenced examples and HTML comments; retain original line numbers for minimal edits.
export function issueTasks(body: string): { line: number; task: string }[] {
  const tasks: { line: number; task: string }[] = [];
  let fence = '';
  let comment = false;
  for (const [line, raw] of body.split('\n').entries()) {
    const value = raw.replace(/\r$/, '');
    if (comment || value.includes('<!--')) {
      comment = !value.includes('-->');
      continue;
    }
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(value)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const match = /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+(.+)$/.exec(value);
    if (match?.[1]) tasks.push({ line, task: match[1].trim() });
  }
  requireCompletion(!fence && !comment, 'UNTERMINATED_ISSUE_MARKUP');
  return tasks;
}

function markdown(value: string): string {
  return value.replace(/[&<>@`\[\]*_]/g, (char) => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, ' ');
}

export function completedBody(plan: Completion, body: string, sourceSha: string, runId: number): string {
  const tasks = issueTasks(body);
  const expected = new Set(plan.acceptance.map((entry) => entry.task));
  requireCompletion(
    new Set(tasks.map((entry) => entry.task)).size === tasks.length,
    'AMBIGUOUS_ISSUE_TASKS',
  );
  if (tasks.length > 0)
    requireCompletion(
      tasks.length === expected.size && tasks.every((entry) => expected.has(entry.task)),
      'UNCOVERED_ISSUE_TASKS',
    );
  const lines = body.split('\n');
  for (const task of tasks) lines[task.line] = lines[task.line]!.replace(/\[[ xX]\]/, '[x]');
  const url = `https://github.com/${repository}`;
  const receipt = [
    completionMarker,
    '## ハーネスによる完了記録',
    '',
    markdown(plan.summary),
    '',
    `- main: ${url}/commit/${sha(sourceSha)}`,
    `- 検証: ${url}/actions/runs/${positiveInteger(runId)}`,
    `- 関連PR: ${plan.pullRequests.map((number) => `${url}/pull/${number}`).join(', ')}`,
    '- 残件: なし（完了宣言をレビュー済み）',
    '',
    ...plan.acceptance.map((entry) => `- [x] ${markdown(entry.task)} — ${markdown(entry.evidence)}`),
  ].join('\n');
  const updated = `${lines.join('\n').trimEnd()}\n\n${receipt}\n`;
  requireCompletion(updated.length <= 60000, 'ISSUE_BODY_TOO_LARGE');
  return updated;
}
