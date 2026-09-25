import assert from 'node:assert/strict';
import { it } from 'vite-plus/test';
import fc from 'fast-check';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { JobStore, JOB_LIMITS, type Claim } from './job-store.ts';
import { withJobs, artifactFor } from '../../test-support/jobs.ts';
import { checkProperty } from '../../../../scripts/harness/test-support/property.ts';

it(
  'compares generated ownership transitions with real SQLite and fences stale notifications',
  { timeout: 45000 },
  async () => {
    const operations = fc.array(
      fc.constantFrom(
        'claim',
        'expire',
        'complete',
        'old-complete',
        'cancel',
        'fail',
        'retry',
        'reconnect',
      ),
      { minLength: 1, maxLength: 24 },
    );
    await checkProperty(
      'sqlite-job-transitions',
      'apps/api/src/jobs/job-properties.test.ts',
      fc.asyncProperty(operations, async (actions) => {
        await withJobs(async ({ store, jobs: initial, submit, result }) => {
          let jobs = initial;
          const job = submit('generated');
          let state = 'queued',
            attempts = 0,
            current: Claim | null = null,
            now = 100;
          const claims: Claim[] = [];
          let completed = false;
          for (const [index, operation] of actions.entries()) {
            now++;
            switch (operation) {
              case 'claim': {
                const claim = jobs.claim(now);
                assert.equal(claim !== null, state === 'queued');
                if (state === 'queued') {
                  current = claim!;
                  claims.push(current);
                  attempts++;
                  state = 'running';
                }
                break;
              }
              case 'expire':
                now += JOB_LIMITS.leaseMs;
                assert.equal(jobs.recover(now), state === 'running' ? 1 : 0);
                if (state === 'running') {
                  state = attempts < JOB_LIMITS.maxAttempts ? 'queued' : 'failed';
                  current = null;
                }
                break;
              case 'complete':
              case 'old-complete': {
                const claim = operation === 'complete' ? claims.at(-1) : claims[0];
                if (!claim) break;
                const accepted: boolean = state === 'running' && claim === current;
                assert.equal(
                  jobs.complete(claim, `result-${index}`, result, artifactFor(claim), now).accepted,
                  accepted,
                );
                if (accepted) {
                  state = 'completed';
                  completed = true;
                }
                break;
              }
              case 'cancel':
                jobs.cancel(job.id, now);
                if (state === 'queued' || state === 'running') state = 'cancelled';
                break;
              case 'fail':
                if (current) {
                  assert.equal(
                    jobs.fail(current, 'injected host failure', now),
                    state === 'running',
                  );
                  if (state === 'running') state = 'failed';
                }
                break;
              case 'retry':
                if (['failed', 'cancelled'].includes(state) && attempts < JOB_LIMITS.maxAttempts) {
                  jobs.retry(job.id, attempts, DEFAULT_BUDGET, now);
                  state = 'queued';
                  current = null;
                }
                break;
              case 'reconnect':
                jobs = new JobStore(store);
                break;
            }
            assert.equal(jobs.get(job.id)!.state, state, `after ${index}: ${operation}`);
            assert.equal(jobs.get(job.id)!.attempts, attempts);
            assert.equal(jobs.canonical(job.simulationHash) !== undefined, completed);
          }
        });
      }),
      {
        examples: [
          [['claim', 'expire', 'claim', 'old-complete', 'complete', 'complete']],
          [['claim', 'cancel', 'complete', 'retry', 'claim', 'complete']],
          [['claim', 'complete', 'cancel', 'reconnect']],
        ],
      },
    );
  },
);
