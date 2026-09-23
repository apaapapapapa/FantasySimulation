import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assessDelivery, natural, objects } from '../delivery.ts';
import { collectSnapshot } from '../github-collect.ts';
import { createGateway } from '../github.ts';
import { record, text, timestamp } from '../report.ts';
import { strings, taskId } from './contract.ts';
import { readJournal } from './journal.ts';
import { ensure, status, transition } from './state.ts';
import { operation, owned, scope } from './workspace.ts';

export async function review(path: string, value: unknown) {
  return operation(path, () => {
    const j = readJournal(path),
      view = status(j),
      dirs = owned(path, j),
      r = record(value);
    const paths = strings(r.reviewedPaths),
      changed = scope(dirs.workspace, j.contract)
        .map((c) => c.path)
        .sort();
    const at = timestamp(r.completedAt);
    ensure(
      view.phase === 'review' &&
        r.candidateSha === view.verifiedSha &&
        at >= view.reviewAt! &&
        at <= new Date().toISOString(),
      'Review identity/interval mismatch',
    );
    ensure(
      JSON.stringify(paths) === JSON.stringify(changed) && r.unresolvedFindings === 0,
      'Review coverage/findings incomplete',
    );
    text(r.summary);
    const evidence = join(dirs.root, 'evidence', `review-${randomUUID()}.json`);
    writeFileSync(evidence, JSON.stringify(r, null, 2), { flag: 'wx', mode: 0o600 });
    const next = transition(path, j, 'reviewed', {
      candidateSha: view.candidateSha,
      method: r.method,
      unresolvedFindings: 0,
      evidence,
    });
    return status(next);
  });
}
export function handoff(path: string) {
  const j = readJournal(path),
    view = status(j),
    dirs = owned(path, j);
  ensure(view.phase === 'delivery', 'Complete source, regression and review first');
  return {
    repository: j.contract.repository,
    branch: `loop/${taskId(j.contract)}`,
    candidateSha: view.candidateSha,
    base: 'main',
    workspace: dirs.workspace,
    changedPaths: scope(dirs.workspace, j.contract).map((c) => c.path),
    goal: j.contract.goal,
    target: 'pr',
    repairComplete: false,
    nextAction:
      'Manually publish exactly this branch/SHA and open a PR; then observe actual current CI/review. No automatic push, merge or deployment.',
  };
}
export function verifyObservation(
  journal: ReturnType<typeof readJournal>,
  snapshot: unknown,
  receipt: unknown,
) {
  const view = status(journal),
    s = record(snapshot),
    pull = record(s.pull),
    head = record(pull.head);
  ensure(
    s.repository === journal.contract.repository &&
      head.sha === view.verifiedSha &&
      head.ref === `loop/${taskId(journal.contract)}` &&
      record(head.repo).full_name === journal.contract.repository &&
      record(pull.base).ref === 'main' &&
      record(record(pull.base).repo).full_name === journal.contract.repository,
    'PR identity mismatch',
  );
  const lastReview = journal.events.findLast((e) => e.type === 'reviewed')!;
  ensure(
    timestamp(s.startedAt) >= lastReview.at &&
      Date.now() - Date.parse(timestamp(s.finishedAt)) <= 120_000 &&
      Date.parse(timestamp(s.finishedAt)) <= Date.now(),
    'Stale delivery collection',
  );
  const result = assessDelivery(snapshot, 'pr', receipt);
  if (journal.contract.review === 'required') {
    const approvals = objects(s.reviews).filter(
      (r) =>
        r.state === 'APPROVED' &&
        r.commit_id === view.verifiedSha &&
        record(r.user).login !== record(pull.user).login,
    );
    ensure(
      approvals.length && s.reviewDecision === 'APPROVED',
      'Required independent GitHub approval missing',
    );
  }
  return result;
}
export async function observe(path: string, input: unknown) {
  return operation(path, async () => {
    const j = readJournal(path),
      view = status(j),
      dirs = owned(path, j),
      options = record(input);
    ensure(view.phase === 'delivery', 'Review not completed');
    const calls = natural(options.calls),
      number = natural(options.number);
    ensure(calls > 0 && calls <= 200 && number > 0, 'Invalid collection budget/PR');
    // Charge the entire collection allowance before transport; interrupted requests cannot be refunded.
    const reserved = transition(path, j, 'collection-reserved', { calls, number });
    const gateway = createGateway(process.env.GH_TOKEN ?? '', {
      requests: calls,
      bytes: 16 * 1024 * 1024,
      deadlineMs: Math.min(120_000, status(reserved).remaining.durationMs),
    });
    const snapshot = await collectSnapshot(gateway, j.contract.repository, number);
    const evidence = join(dirs.root, 'evidence', `delivery-${reserved.revision}.json`);
    writeFileSync(evidence, JSON.stringify({ snapshot, receipt: options.receipt }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    owned(path, reserved);
    const result = verifyObservation(reserved, snapshot, options.receipt);
    return status(
      transition(path, reserved, 'observed', {
        candidateSha: view.candidateSha,
        complete: result.exitCode === 0,
        evidence,
      }),
    );
  });
}
