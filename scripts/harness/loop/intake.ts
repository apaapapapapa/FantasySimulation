import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { natural, objects } from '../delivery.ts';
import { collectPages } from '../github-collect.ts';
import type { Gateway } from '../github.ts';
import { readBoundedJson } from '../files.ts';
import { record, sha, text } from '../report.ts';
import { artifactDirectory } from '../source.ts';
import { digest } from './contract.ts';
import { ensure } from './state.ts';

export const INTAKE_REPOSITORY = 'apaapapapapa/FantasySimulation';
const ciPath = '.github/workflows/ci.yml';
function runIdentity(value: unknown, repositoryId: number) {
  const r = record(value);
  ensure(
    record(r.repository).full_name === INTAKE_REPOSITORY &&
      record(r.repository).id === repositoryId &&
      record(r.head_repository).full_name === INTAKE_REPOSITORY &&
      record(r.head_repository).id === repositoryId &&
      r.path === ciPath &&
      r.name === 'CI' &&
      r.event === 'push' &&
      r.head_branch === 'main',
    'Untrusted CI identity',
  );
  const id = natural(r.id),
    attempt = natural(r.run_attempt),
    workflow = natural(r.workflow_id);
  ensure(id > 0 && attempt > 0 && workflow > 0, 'Missing run identity');
  return {
    id,
    attempt,
    workflow,
    sha: sha(r.head_sha),
    status: text(r.status),
    conclusion: r.conclusion,
    updatedAt: text(r.updated_at),
  };
}
export interface Intake {
  schemaVersion: 1;
  stage: 'proposal';
  repository: string;
  observedAt: string;
  status: 'proposed' | 'superseded' | 'unknown';
  reason: string;
  repaired: false;
  source: { runId: number; attempt: number; sha: string } | null;
  candidates: {
    id: string;
    goal: string;
    sourceSha: string;
    failedCheck: string;
    jobId: number;
    sourceUrl: string;
  }[];
}
export async function collectIntake(gateway: Gateway, event: unknown): Promise<Intake> {
  const output: Intake = {
    schemaVersion: 1,
    stage: 'proposal',
    repository: INTAKE_REPOSITORY,
    observedAt: new Date().toISOString(),
    status: 'unknown',
    reason: 'Not collected',
    repaired: false,
    source: null,
    candidates: [],
  };
  try {
    const e = record(event),
      repository = record(e.repository),
      repositoryId = natural(repository.id);
    ensure(
      e.action === 'completed' && repository.full_name === INTAKE_REPOSITORY && repositoryId > 0,
      'Wrong webhook repository/action',
    );
    const trigger = runIdentity(e.workflow_run, repositoryId);
    ensure(
      trigger.status === 'completed' &&
        ['failure', 'timed_out'].includes(String(trigger.conclusion)),
      'Not a completed failed main push',
    );
    output.source = { runId: trigger.id, attempt: trigger.attempt, sha: trigger.sha };
    const prefix = `/repos/${INTAKE_REPOSITORY}`;
    const repo = record(await gateway.get(`GET ${prefix}`));
    ensure(
      repo.id === repositoryId &&
        repo.full_name === INTAKE_REPOSITORY &&
        repo.default_branch === 'main',
      'Live repository mismatch',
    );
    const currentMain = () =>
      gateway
        .get(`GET ${prefix}/branches/main`)
        .then((value) => sha(record(record(value).commit).sha));
    const main = await currentMain();
    const run = () =>
      gateway
        .get(`GET ${prefix}/actions/runs/${trigger.id}`)
        .then((v) => runIdentity(v, repositoryId));
    const before = await run();
    if (
      main !== trigger.sha ||
      before.attempt > trigger.attempt ||
      before.conclusion === 'success'
    ) {
      output.status = 'superseded';
      output.reason = 'Main or run attempt already advanced';
      return output;
    }
    ensure(digest(before) === digest(trigger), 'Webhook/run identity mismatch');
    const workflow = record(
      await gateway.get(`GET ${prefix}/actions/workflows/${trigger.workflow}`),
    );
    ensure(
      workflow.id === trigger.workflow && workflow.path === ciPath && workflow.name === 'CI',
      'Unexpected workflow',
    );
    const runs = async () => {
      const rows = await collectPages(
        gateway,
        `GET ${prefix}/actions/workflows/${trigger.workflow}/runs`,
        { branch: 'main', event: 'push', head_sha: main },
      );
      return rows
        .map((r) => runIdentity(r, repositoryId))
        .sort((a, b) => b.id - a.id || b.attempt - a.attempt);
    };
    const latest = await runs();
    ensure(latest.length > 0, 'Missing latest CI');
    if (latest[0]!.id !== trigger.id || latest[0]!.attempt !== trigger.attempt) {
      output.status = 'superseded';
      output.reason = 'A newer CI run exists for this SHA';
      return output;
    }
    ensure(digest(latest[0]) === digest(before), 'Latest CI changed');
    const rows = objects(
      await collectPages(
        gateway,
        `GET ${prefix}/actions/runs/${trigger.id}/attempts/${trigger.attempt}/jobs`,
      ),
    );
    ensure(rows.length > 0, 'No job evidence');
    const failed = [];
    for (const job of rows) {
      ensure(
        job.run_id === trigger.id &&
          job.run_attempt === trigger.attempt &&
          job.head_sha === main &&
          job.head_branch === 'main' &&
          job.workflow_name === 'CI' &&
          job.status === 'completed',
        'Incomplete or unrelated job',
      );
      const name = text(job.name);
      ensure(name.length <= 250 && !/[\x00-\x1f]/.test(name), 'Invalid check name');
      ensure(
        typeof job.conclusion === 'string' &&
          [
            'success',
            'failure',
            'timed_out',
            'cancelled',
            'skipped',
            'neutral',
            'action_required',
            'stale',
          ].includes(job.conclusion),
        'Unknown job conclusion',
      );
      const jobId = natural(job.id);
      ensure(jobId > 0, 'Missing job ID');
      if (job.conclusion === 'failure' || job.conclusion === 'timed_out')
        failed.push({ name, jobId });
    }
    ensure(
      failed.length > 0 &&
        failed.length <= 20 &&
        new Set(failed.map((f) => f.name)).size === failed.length,
      'Ambiguous or excessive failures',
    );
    const after = await run(),
      latestAfter = await runs(),
      mainAfter = await currentMain();
    ensure(
      mainAfter === main &&
        digest(before) === digest(after) &&
        digest(latest) === digest(latestAfter),
      'Collection changed; recheck current CI',
    );
    output.candidates = failed
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, jobId }) => ({
        id: digest([INTAKE_REPOSITORY, 'ci', main, name]),
        goal: `Investigate CI failure: ${name}`,
        sourceSha: main,
        failedCheck: name,
        jobId,
        sourceUrl: `https://github.com/${INTAKE_REPOSITORY}/actions/runs/${trigger.id}/attempts/${trigger.attempt}`,
      }));
    output.status = 'proposed';
    output.reason = 'Current failures collected; explicit adoption required';
  } catch (error) {
    output.status = 'unknown';
    output.reason = error instanceof Error ? error.message : 'Incomplete intake';
    output.candidates = [];
  } finally {
    gateway.close();
  }
  return output;
}
export async function intakeFromWorkflow(directory: string) {
  ensure(
    process.env.GITHUB_EVENT_NAME === 'workflow_run' &&
      process.env.GITHUB_REPOSITORY === INTAKE_REPOSITORY,
    'Only trusted workflow_run intake is supported',
  );
  const event = readBoundedJson(text(process.env.GITHUB_EVENT_PATH));
  const { createGateway } = await import('../github.ts');
  const result = await collectIntake(
    createGateway(process.env.GH_TOKEN ?? '', {
      requests: 100,
      bytes: 4 * 1024 * 1024,
      deadlineMs: 60_000,
    }),
    event,
  );
  const output = artifactDirectory(process.cwd(), directory);
  writeFileSync(join(output, 'intake.json'), JSON.stringify(result, null, 2));
  return { report: result, exitCode: result.status === 'unknown' ? 2 : 0 };
}
