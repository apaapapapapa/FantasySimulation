import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';
import {
  collectPages,
  collectRun,
  collectSnapshot,
  collectThreads,
  sourceFromLog,
  markerFromLog,
} from './github-collect.ts';
import type { Gateway, Page } from './github.ts';
import type { Report } from './report.ts';
import { classify } from '../ci/plan.ts';

function gateway(pages: Page[] = []): Gateway {
  return {
    async get() {
      throw new Error('fixture has no response');
    },
    async *pages() {
      yield* pages;
    },
    async query() {
      throw new Error('fixture has no query response');
    },
    close() {},
  };
}
const page = (nodes: unknown[], more = false, cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: cursor },
});
describe('complete, bounded collection', () => {
  it('collects all REST pages, verifies totals and refuses missing final pages', async () => {
    assert.equal(
      (
        await collectPages(
          gateway([
            { data: [{ id: 1 }], next: true, total: 2 },
            { data: [{ id: 2 }], next: false, total: 2 },
          ]),
          'GET /repos/owner/repo/pulls',
        )
      ).length,
      2,
    );
    await assert.rejects(
      collectPages(gateway([{ data: [], next: true, total: null }]), 'GET /repos/owner/repo/pulls'),
      /Incomplete/,
    );
    await assert.rejects(
      collectPages(
        gateway([{ data: [{ id: 1 }], next: false, total: 2 }]),
        'GET /repos/owner/repo/pulls',
      ),
      /Incomplete/,
    );
    await assert.rejects(
      collectPages(
        gateway([
          { data: [{ id: 1 }], next: true, total: 2 },
          { data: [{ id: 1 }], next: false, total: 2 },
        ]),
        'GET /repos/owner/repo/pulls',
      ),
      /Duplicate/,
    );
  });
  it('collects nested thread comments and outer thread pages independently', async () => {
    const client = gateway();
    const calls: (string | number | null | undefined)[] = [];
    client.query = async (query, variables) => {
      calls.push(variables.cursor);
      if (query.includes('query ThreadComments'))
        return { node: { id: 'thread-1', comments: page([{ id: 'reply' }]) } };
      const nodes =
        variables.cursor === null
          ? page(
              [
                {
                  id: 'thread-1',
                  isResolved: true,
                  isOutdated: false,
                  comments: page([{ id: 'first' }], true, 'inner'),
                },
              ],
              true,
              'outer',
            )
          : page([
              {
                id: 'thread-2',
                isResolved: true,
                isOutdated: false,
                comments: page([{ id: 'other' }]),
              },
            ]);
      return {
        repository: {
          pullRequest: { headRefOid: 'a'.repeat(40), reviewDecision: null, reviewThreads: nodes },
        },
      };
    };
    const result = await collectThreads(client, 'owner/repo', 1, 'a'.repeat(40));
    assert.equal(result.threads.length, 2);
    assert.equal((result.threads[0] as { comments: unknown[] }).comments.length, 2);
    assert.deepEqual(calls, [null, 'inner', 'outer']);
  });
  it('rejects partial GraphQL, repeated cursors and head changes', async () => {
    const client = gateway();
    client.query = async () => ({
      repository: {
        pullRequest: { headRefOid: 'b'.repeat(40), reviewDecision: null, reviewThreads: page([]) },
      },
    });
    await assert.rejects(collectThreads(client, 'owner/repo', 1, 'a'.repeat(40)), /changed/);
    client.query = async () => ({
      repository: {
        pullRequest: {
          headRefOid: 'a'.repeat(40),
          reviewDecision: null,
          reviewThreads: page([], true, 'repeat'),
        },
      },
    });
    await assert.rejects(collectThreads(client, 'owner/repo', 1, 'a'.repeat(40)), /Repeated/);
    client.query = async () => ({ repository: null, errors: [{ message: 'partial' }] });
    await assert.rejects(collectThreads(client, 'owner/repo', 1, 'a'.repeat(40)));
  });
  it('closes the transport even when the first authenticated read fails', async () => {
    const client = gateway();
    let closed = false;
    client.close = () => {
      closed = true;
    };
    await assert.rejects(collectSnapshot(client, 'owner/repo', 1));
    assert.equal(closed, true);
  });
  it('requires one actual outer-run source report marker', () => {
    const sourceSha = 'a'.repeat(40);
    const report: Report = {
      schemaVersion: 1,
      producer: 'source-runner',
      sourceSha,
      candidateSha: sourceSha,
      baselineSha: null,
      testMergeSha: null,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:00Z',
      checks: [
        {
          id: 'source-verify',
          required: true,
          status: 'pass',
          reason: 'fixture',
          evidence: [{ uri: 'log.txt', sourceSha }],
        },
      ],
    };
    const line = `2026-01-01T00:00:00Z FANTASY_SOURCE_REPORT=${JSON.stringify(report)}\n`;
    assert.equal(sourceFromLog(line).report.sourceSha, sourceSha);
    assert.match(sourceFromLog(line).logDigest, /^[a-f0-9]{64}$/);
    assert.throws(() => sourceFromLog('no report'));
    assert.throws(() => sourceFromLog(line + line));
    assert.throws(() => sourceFromLog('FANTASY_SOURCE_REPORT={"bad":true}'));
  });
});

it('parses CI markers separately and rejects duplicates, missing or unknown marker names', () => {
  const value = { sourceSha: 'a'.repeat(40), full: false };
  const line = `2026-01-01T00:00:00Z FANTASY_CI_PLAN=${JSON.stringify(value)}\n`;
  assert.deepEqual(markerFromLog(line, 'FANTASY_CI_PLAN').value, value);
  assert.throws(() => markerFromLog(line, 'FANTASY_CI_GATE'));
  assert.throws(() => markerFromLog(line + line, 'FANTASY_CI_PLAN'));
  assert.throws(() => markerFromLog(line, '.*'));
});

it('reads the Linux source report from the ci-gate aggregate, and only for full plans', async () => {
  const sourceSha = 'a'.repeat(40);
  const report = (producer: string): Report => ({
    schemaVersion: 1,
    producer,
    sourceSha,
    candidateSha: sourceSha,
    baselineSha: null,
    testMergeSha: null,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
    checks: [
      {
        id: 'fixture',
        required: true,
        status: 'pass',
        reason: 'fixture',
        evidence: [{ uri: 'log.txt', sourceSha }],
      },
    ],
  });
  const line = (marker: string, value: unknown) =>
    `2026-01-01T00:00:00Z ${marker}=${JSON.stringify(value)}\n`;
  const run = async (full: boolean, gateSource: boolean) => {
    const info = {
      sourceSha,
      candidateSha: 'b'.repeat(40),
      baselineSha: 'c'.repeat(40),
      testMergeSha: sourceSha,
    };
    const plan = classify(info, 'pull_request', [full ? 'apps/api/src/main.ts' : 'README.md']);
    const logs: Record<string, string> = {
      1: line('FANTASY_CI_PLAN', plan),
      2:
        line('FANTASY_CI_GATE', report('ci-gate')) +
        (gateSource ? line('FANTASY_SOURCE_REPORT', report('source-runner')) : ''),
      3: line('FANTASY_DOCS_REPORT', report('docs-check')),
    };
    const jobs = ['changes', 'ci-gate', 'Docs (ubuntu-latest)'].map((name, index) => ({
      id: index + 1,
      name,
      status: 'completed',
      conclusion: name.startsWith('Docs') && full ? 'skipped' : 'success',
    }));
    const client: Gateway = {
      ...gateway([{ data: jobs, next: false, total: jobs.length }]),
      async get(route) {
        const job = /\/actions\/jobs\/(\d+)\/logs$/.exec(route)?.[1];
        if (job) return logs[job];
        if (route.endsWith('/actions/runs/10')) return { id: 10, run_attempt: 1 };
        return { sha: sourceSha };
      },
    };
    return collectRun(client, 'GET /repos/owner/repo', { id: 10 });
  };
  const full = await run(true, true);
  assert.deepEqual(
    full.sources.map((source) => [source.jobId, (source.report as Report).producer]),
    [[2, 'source-runner']],
  );
  const docs = await run(false, false);
  assert.deepEqual(
    docs.sources.map((source) => [source.jobId, (source.report as Report).producer]),
    [[3, 'docs-check']],
  );
  // A full plan whose gate never aggregated the source receipts cannot be collected.
  await assert.rejects(run(true, false), /marker missing/);
});
