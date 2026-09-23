import { describe, expect, it } from 'vite-plus/test';
import { classify } from './plan.ts';
import { assessTasks, expectedTasks, taskCommand } from './verify.ts';
import { loadBoundary, loadFixture } from '../harness/test-support/load.ts';
import { validateSource } from '../harness/issue-completion.ts';

describe('source task collection', () => {
  it('requires complete successful tasks from the same revision and attempt, including after merge', () => {
    const { info } = loadFixture();
    const plan = classify(info, 'push', ['scripts/ci/verify.ts']);
    const run = { runId: '123', runAttempt: '2' };
    const receipts = expectedTasks(plan).map((task) => {
      const report = loadBoundary(info);
      report.producer = 'source-task';
      report.checks = report.checks
        .slice(0, 2)
        .map((check, index) => ({ ...check, id: index ? 'source-verify' : 'source-clean' }));
      return {
        task,
        report,
        command: taskCommand(task),
        exitCode: 0,
        bounded: false,
        logHash: 'a'.repeat(64),
        ...run,
      };
    });
    expect(assessTasks(plan, receipts, run)).toHaveLength(6);
    for (const edits of [
      { task: 'unknown' },
      { exitCode: 1 },
      { bounded: true },
      { runAttempt: '1' },
      { command: ['echo', 'ok'] },
      { report: { ...receipts[0]!.report, sourceSha: 'd'.repeat(40) } },
    ])
      expect(() =>
        assessTasks(plan, [{ ...receipts[0], ...edits }, ...receipts.slice(1)], run),
      ).toThrow(Error);
    for (const rows of [receipts.slice(1), [...receipts, receipts[0]]])
      expect(() => assessTasks(plan, rows, run)).toThrow(Error);
    const source = { ...receipts[0]!.report, producer: 'source-runner' };
    const command = {
      ...info,
      command: ['node', 'scripts/ci/verify.ts', 'aggregate'],
      exitCode: 0,
      signal: null,
      bounded: false,
      cleanBefore: true,
      cleanAfter: true,
      receipts,
      plan,
      ...run,
    };
    expect(() => validateSource(source, command, info.sourceSha)).not.toThrow();
    expect(() =>
      validateSource(source, { ...command, receipts: receipts.slice(1) }, info.sourceSha),
    ).toThrow(Error);
  });
});
