import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport, record, sha, text } from './report.ts';
import { artifactDirectory } from './source.ts';
import { newestRun, natural, objects, repositoryName, DOCS_JOBS } from './delivery.ts';
import type { DeliverySnapshot, RunEvidence } from './delivery.ts';
import type { Gateway } from './github.ts';
import { parsePlan } from '../ci/plan.ts';

const COMMENT_FIELDS =
  'nodes { id databaseId body url updatedAt author { login } } pageInfo { endCursor hasNextPage }';
const THREAD_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid reviewDecision
    reviewThreads(first: 100, after: $cursor) {
      nodes { id isResolved isOutdated comments(first: 100) { ${COMMENT_FIELDS} } }
      pageInfo { endCursor hasNextPage }
    }
  } }
}`;
const COMMENT_QUERY = `query ThreadComments($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    id comments(first: 100, after: $cursor) { ${COMMENT_FIELDS} }
  } }
}`;

/** SDK pagination is still constrained and checked for partial/changing collections. */
export async function collectPages(
  gateway: Gateway,
  route: string,
  parameters: Record<string, string | number> = {},
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pages = 0;
  let next = true;
  let total: number | null = null;
  for await (const page of gateway.pages(route, parameters)) {
    if (!next || ++pages > 50) throw new Error('Pagination is inconsistent or over budget');
    objects(page.data);
    if (page.total !== null) {
      natural(page.total);
      if (total !== null && total !== page.total)
        throw new Error('Collection changed during pagination');
      total = page.total;
    }
    items.push(...page.data);
    if (items.length > 5000) throw new Error('Collection exceeds row budget');
    next = page.next;
  }
  if (!pages || next || (total !== null && items.length !== total))
    throw new Error('Incomplete pagination');
  const ids = items.map((item) => record(item).id).filter((id) => id !== undefined);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate IDs across pages');
  return items;
}
function connection(value: unknown) {
  const data = record(value);
  const page = record(data.pageInfo);
  if (
    typeof page.hasNextPage !== 'boolean' ||
    (page.hasNextPage && typeof page.endCursor !== 'string')
  )
    throw new Error('Invalid GraphQL page information');
  return {
    nodes: objects(data.nodes),
    more: page.hasNextPage,
    cursor: page.hasNextPage ? text(page.endCursor) : null,
  };
}
export async function collectThreads(
  gateway: Gateway,
  repository: string,
  number: number,
  candidate: string,
) {
  const [owner, name] = repositoryName(repository).split('/');
  const variables = { owner: owner!, name: name!, number };
  const threads: unknown[] = [];
  const threadIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let decision: string | null = null;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const data = record(await gateway.query(THREAD_QUERY, { ...variables, cursor }));
    const pull = record(record(data.repository).pullRequest);
    if (pull.headRefOid !== candidate) throw new Error('PR changed during review collection');
    if (
      pull.reviewDecision !== null &&
      (typeof pull.reviewDecision !== 'string' ||
        !['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pull.reviewDecision))
    )
      throw new Error('Invalid review decision');
    if (pageNumber > 0 && decision !== pull.reviewDecision)
      throw new Error('Review decision changed');
    decision = pull.reviewDecision as string | null;
    const page = connection(pull.reviewThreads);
    for (const thread of page.nodes) {
      const id = text(thread.id);
      if (threadIds.has(id) || typeof thread.isResolved !== 'boolean')
        throw new Error('Duplicate or invalid review thread');
      threadIds.add(id);
      const initial = connection(thread.comments);
      const comments: unknown[] = [...initial.nodes];
      let next = initial.more;
      let commentCursor = initial.cursor;
      const seen = new Set<string>();
      for (let nested = 0; next && nested < 50; nested++) {
        if (!commentCursor || seen.has(commentCursor)) throw new Error('Repeated comment cursor');
        seen.add(commentCursor);
        const node = record(
          record(await gateway.query(COMMENT_QUERY, { id, cursor: commentCursor })).node,
        );
        if (node.id !== id) throw new Error('Thread identity changed');
        const part = connection(node.comments);
        comments.push(...part.nodes);
        next = part.more;
        commentCursor = part.cursor;
      }
      if (next || comments.length > 5000) throw new Error('Incomplete thread comments');
      const commentIds = objects(comments).map((comment) => text(comment.id));
      if (new Set(commentIds).size !== commentIds.length)
        throw new Error('Duplicate thread comment');
      threads.push({ id, isResolved: thread.isResolved, isOutdated: thread.isOutdated, comments });
    }
    if (!page.more) return { threads, decision };
    if (!page.cursor || cursors.has(page.cursor)) throw new Error('Repeated review cursor');
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  throw new Error('Incomplete review threads');
}
export function sourceFromLog(value: unknown) {
  const parsed = markerFromLog(value, 'FANTASY_SOURCE_REPORT');
  return { report: parseReport(parsed.value), logDigest: parsed.logDigest };
}
export function markerFromLog(value: unknown, marker: string) {
  if (
    ![
      'FANTASY_SOURCE_REPORT',
      'FANTASY_DOCS_REPORT',
      'FANTASY_CI_PLAN',
      'FANTASY_CI_GATE',
    ].includes(marker)
  )
    throw new Error('Unknown evidence marker');
  const content =
    typeof value === 'string'
      ? value
      : value instanceof ArrayBuffer
        ? Buffer.from(value).toString('utf8')
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('utf8')
          : null;
  if (content === null || Buffer.byteLength(content) > 4 * 1024 * 1024)
    throw new Error('Invalid or excessive job log');
  const markers = content
    .split('\n')
    .map((line) => new RegExp(`${marker}=(\\{.*\\})\\s*$`).exec(line)?.[1])
    .filter((line): line is string => line !== undefined);
  if (markers.length !== 1) throw new Error('Source report marker missing or ambiguous');
  return {
    value: JSON.parse(markers[0]!) as unknown,
    logDigest: createHash('sha256').update(content).digest('hex'),
  };
}
export async function collectRun(
  gateway: Gateway,
  prefix: string,
  selected: Record<string, unknown>,
): Promise<RunEvidence> {
  const id = natural(selected.id);
  const before = record(await gateway.get(`${prefix}/actions/runs/${id}`));
  const attempt = natural(before.run_attempt);
  if (before.id !== id || attempt < 1) throw new Error('Run identity mismatch');
  const jobs = await collectPages(gateway, `${prefix}/actions/runs/${id}/attempts/${attempt}/jobs`);
  const sources: RunEvidence['sources'] = [];
  const commits: Record<string, unknown> = {};
  let plan: RunEvidence['plan'];
  let gate: RunEvidence['gate'];
  let gateLog: unknown = null;
  const addSource = async (
    jobId: number,
    log: unknown,
    marker: 'FANTASY_SOURCE_REPORT' | 'FANTASY_DOCS_REPORT',
  ) => {
    const parsed = markerFromLog(log, marker);
    const report = parseReport(parsed.value);
    sources.push({ jobId, report, logDigest: parsed.logDigest });
    if (!(report.sourceSha in commits))
      commits[report.sourceSha] = await gateway.get(`${prefix}/commits/${sha(report.sourceSha)}`);
  };
  for (const job of objects(jobs)) {
    if (job.status !== 'completed' || job.conclusion === 'skipped') continue;
    if (job.name === 'changes' || job.name === 'ci-gate') {
      const log = await gateway.get(`${prefix}/actions/jobs/${natural(job.id)}/logs`);
      const parsed = markerFromLog(
        log,
        job.name === 'changes' ? 'FANTASY_CI_PLAN' : 'FANTASY_CI_GATE',
      );
      if (job.name === 'changes') {
        if (plan) throw new Error('Duplicate plan job');
        plan = {
          jobId: natural(job.id),
          value: parsePlan(parsed.value),
          logDigest: parsed.logDigest,
        };
      } else {
        if (gate) throw new Error('Duplicate gate job');
        gate = {
          jobId: natural(job.id),
          report: parseReport(parsed.value),
          logDigest: parsed.logDigest,
        };
        gateLog = log;
      }
      continue;
    }
    if (DOCS_JOBS.some((name) => name === job.name))
      await addSource(
        natural(job.id),
        await gateway.get(`${prefix}/actions/jobs/${natural(job.id)}/logs`),
        'FANTASY_DOCS_REPORT',
      );
  }
  // A full plan's Linux source report comes from the aggregate step inside ci-gate itself.
  if (gate && plan && parsePlan(plan.value).full)
    await addSource(gate.jobId, gateLog, 'FANTASY_SOURCE_REPORT');
  const after = await gateway.get(`${prefix}/actions/runs/${id}`);
  return {
    before,
    after,
    jobs,
    sources,
    commits,
    ...(plan ? { plan } : {}),
    ...(gate ? { gate } : {}),
  };
}
/** Collecting a snapshot is not approval, merge, release, or successful delivery. */
async function collectSnapshotBody(
  gateway: Gateway,
  repository: string,
  number: number,
): Promise<DeliverySnapshot> {
  repositoryName(repository);
  if (natural(number) < 1) throw new Error('Invalid PR number');
  const prefix = `GET /repos/${repository}`;
  const startedAt = new Date().toISOString();
  const pull = record(await gateway.get(`${prefix}/pulls/${number}`));
  const candidate = sha(record(pull.head).sha);
  if (pull.number !== number || record(record(pull.base).repo).full_name !== repository)
    throw new Error('Foreign pull request');
  const snapshot: DeliverySnapshot = {
    schemaVersion: 1,
    repository,
    number,
    startedAt,
    finishedAt: startedAt,
    pull,
    pullAfter: pull,
    comments: [],
    reviews: [],
    files: [],
    threads: [],
    reviewDecision: null,
    prRuns: [],
    prRunsAfter: [],
    mainRuns: [],
    mainRunsAfter: [],
    prRun: null,
    mainRun: null,
    checks: [],
    statuses: [],
    errors: [],
  };
  let stage = 'comments';
  try {
    snapshot.comments = await collectPages(gateway, `${prefix}/issues/${number}/comments`);
    stage = 'reviews';
    snapshot.reviews = await collectPages(gateway, `${prefix}/pulls/${number}/reviews`);
    stage = 'files';
    snapshot.files = await collectPages(gateway, `${prefix}/pulls/${number}/files`);
    if (snapshot.files.length !== natural(pull.changed_files))
      throw new Error('Changed-file coverage mismatch');
    stage = 'review-threads';
    const review = await collectThreads(gateway, repository, number, candidate);
    snapshot.threads = review.threads;
    snapshot.reviewDecision = review.decision;
    stage = 'commit-checks';
    snapshot.checks = await collectPages(gateway, `${prefix}/commits/${candidate}/check-runs`, {
      filter: 'latest',
    });
    snapshot.statuses = await collectPages(gateway, `${prefix}/commits/${candidate}/statuses`);
    stage = 'pr-ci';
    const runsPath = `${prefix}/actions/workflows/ci.yml/runs`;
    snapshot.prRuns = await collectPages(gateway, runsPath, {
      head_sha: candidate,
      event: 'pull_request',
    });
    const pr = newestRun(snapshot.prRuns, candidate, 'pull_request');
    if (pr) snapshot.prRun = await collectRun(gateway, prefix, pr);
    if (pull.merged === true) {
      stage = 'main-ci';
      const merge = sha(pull.merge_commit_sha);
      snapshot.mainRuns = await collectPages(gateway, runsPath, {
        head_sha: merge,
        event: 'push',
        branch: 'main',
      });
      const main = newestRun(snapshot.mainRuns, merge, 'push');
      if (main) snapshot.mainRun = await collectRun(gateway, prefix, main);
      snapshot.mainRunsAfter = await collectPages(gateway, runsPath, {
        head_sha: merge,
        event: 'push',
        branch: 'main',
      });
    }
    stage = 'final-snapshot';
    snapshot.prRunsAfter = await collectPages(gateway, runsPath, {
      head_sha: candidate,
      event: 'pull_request',
    });
    snapshot.pullAfter = await gateway.get(`${prefix}/pulls/${number}`);
  } catch {
    // Error messages/request objects may contain authorization headers; retain only a stage code.
    snapshot.errors.push(`incomplete:${stage}`);
  }
  snapshot.finishedAt = new Date().toISOString();
  return snapshot;
}
export function saveSnapshot(root: string, relative: string, snapshot: DeliverySnapshot) {
  const directory = artifactDirectory(root, relative);
  writeFileSync(join(directory, 'github-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return directory;
}

export async function collectSnapshot(
  gateway: Gateway,
  repository: string,
  number: number,
): Promise<DeliverySnapshot> {
  try {
    return await collectSnapshotBody(gateway, repository, number);
  } finally {
    gateway.close();
  }
}
