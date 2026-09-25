import { expect, it } from 'vite-plus/test';
import { canCancelJob, canRetryJob } from './job-transitions.ts';

it.each([
  ['queued', null, null, 0, true, false],
  ['running', null, null, 1, true, false],
  ['failed', null, null, 1, false, true],
  ['cancelled', null, null, 1, false, true],
  ['failed', null, 'determinism-violation', 1, false, false],
  ['completed', 'truncated', null, 1, false, true],
  ['completed', 'unresolved', null, 1, false, true],
  ['completed', 'win', null, 1, false, false],
  ['completed', 'draw', null, 1, false, false],
  ['failed', null, null, 3, false, false],
] as const)(
  'shares allowed transitions for %s/%s/%s after %s attempts',
  (state, outcome, failureCode, attempts, cancel, retry) => {
    const job = { state, attempts, maxAttempts: 3, failureCode };
    expect(canCancelJob(job)).toBe(cancel);
    expect(canRetryJob(job, outcome)).toBe(retry);
  },
);
