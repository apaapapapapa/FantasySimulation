import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from './contract.ts';
import { initialize, readJournal } from './journal.ts';
import { begin, status, transition } from './state.ts';
import { assertionOutcome } from './regression.ts';

const at = '2026-09-23T00:00:00.000Z',
  candidateSha = 'b'.repeat(40);
function model(review = 'optional') {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-review-'));
  const path = initialize(
    root,
    {
      schemaVersion: 1,
      repository: 'owner/repo',
      baselineSha: 'a'.repeat(40),
      goal: 'Review binding',
      allowedPaths: ['src'],
      requiredChecks: ['source-clean', 'source-verify'],
      budget: DEFAULT_BUDGET,
      review,
      reviewWaitMs: 900_000,
      target: 'pr',
    },
    at,
  );
  const event = (type: string, data: Record<string, unknown>, time = at) =>
    transition(path, readJournal(path), type, data, time);
  event('prepared', { workspace: '/owned' });
  const attempt = () => {
    begin(path, { hypothesis: 'Repair', externalCalls: 100, costMicros: 0 }, at);
    const baseSha = status(readJournal(path), at).candidateSha;
    event('applying', { baseSha, patchHash: 'c'.repeat(64) });
    event('applied', { candidateSha, patchHash: 'c'.repeat(64) });
  };
  return { path, event, attempt, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
it('does not complete on evaluation alone, timeout alone, stale review or missing regression', () => {
  const f = model();
  try {
    f.attempt();
    f.event('evaluated', { candidateSha, outcome: 'pass', passed: 2, evidence: 'source.json' });
    const receipt = {
      candidateSha,
      method: 'self',
      unresolvedFindings: 0,
      evidence: 'review.json',
    };
    expect(() => f.event('reviewed', receipt, '2026-09-23T00:16:00.000Z')).toThrow(/Regression/);
    f.event('regression', { candidateSha, evidence: 'regression.json' });
    expect(() => f.event('reviewed', receipt)).toThrow(/wait/);
    expect(() => f.event('reviewed', { ...receipt, candidateSha: 'a'.repeat(40) })).toThrow(
      /Stale/,
    );
    expect(status(readJournal(f.path), '2026-09-23T00:16:00.000Z').phase).toBe('review');
    f.event('reviewed', receipt, '2026-09-23T00:16:00.000Z');
    f.event('collection-reserved', { calls: 80 }, '2026-09-23T00:17:00.000Z');
    expect(() => f.event('collection-reserved', { calls: 21 }, '2026-09-23T00:17:00.000Z')).toThrow(
      /reservation/,
    );
    f.event(
      'observed',
      { candidateSha, complete: false, evidence: 'pending-ci.json' },
      '2026-09-23T00:17:00.000Z',
    );
    expect(status(readJournal(f.path), '2026-09-23T00:17:00.000Z').phase).toBe('delivery');
  } finally {
    f.dispose();
  }
});
it('cannot substitute self review for required external review', () => {
  const f = model('required');
  try {
    f.attempt();
    f.event('evaluated', { candidateSha, outcome: 'pass', passed: 2, evidence: 'source.json' });
    f.event('regression', { candidateSha, evidence: 'regression.json' });
    expect(() =>
      f.event(
        'reviewed',
        { candidateSha, method: 'self', unresolvedFindings: 0, evidence: 'receipt.json' },
        '2026-09-23T00:16:00.000Z',
      ),
    ).toThrow(/cannot fall back/);
  } finally {
    f.dispose();
  }
});
it('stops on no improvement and never refunds repeated failed attempts', () => {
  const f = model();
  try {
    for (let i = 0; i < 2; i++) {
      f.attempt();
      f.event('evaluated', { candidateSha, outcome: 'fail', passed: 0, evidence: 'failure.json' });
    }
    expect(status(readJournal(f.path), at)).toMatchObject({
      phase: 'stopped',
      attempts: 2,
      externalCalls: 200,
      noProgress: 2,
    });
    expect(() => f.attempt()).toThrow();
  } finally {
    f.dispose();
  }
});
it.each([
  ['AssertionError: expected 0 to be 1', 'assertion-failed'],
  ['Error: failed to import module', 'unknown'],
  ['ReferenceError: missing setup', 'unknown'],
])('distinguishes a real assertion from setup failure: %s', (message, expected) => {
  const result = {
    testResults: [
      {
        name: '/repo/src/new.test.ts',
        status: 'failed',
        assertionResults: [
          { fullName: 'returns the expected value', status: 'failed', failureMessages: [message] },
        ],
      },
    ],
  };
  const execution = {
    schemaVersion: 1,
    hooksExecuted: false,
    unhandledErrors: 0,
    tests: [
      {
        file: '/repo/src/new.test.ts',
        name: 'returns the expected value',
        state: 'failed',
        errors: ['AssertionError'],
      },
    ],
  };
  expect(
    assertionOutcome(result, '/repo/src/new.test.ts', 'returns the expected value', execution),
  ).toBe(expected);
  expect(assertionOutcome(result, '/repo/src/new.test.ts', 'unexecuted test', execution)).toBe(
    'unknown',
  );
  expect(
    assertionOutcome(result, '/repo/src/new.test.ts', 'returns the expected value', {
      ...execution,
      hooksExecuted: true,
    }),
  ).toBe('unknown');
});
