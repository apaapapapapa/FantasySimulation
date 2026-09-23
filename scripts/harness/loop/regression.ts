import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { objects } from '../delivery.ts';
import { readBoundedJson } from '../files.ts';
import { record, text } from '../report.ts';
import { git } from '../source.ts';
import { digest, isTestPath, relativePath } from './contract.ts';
import { isolatedCommand } from './evaluation.ts';
import { readJournal, regularPath } from './journal.ts';
import { ensure, status, transition } from './state.ts';
import { copyDependencies, operation, owned, scope } from './workspace.ts';

export function assertionOutcome(
  value: unknown,
  file: string,
  name: string,
  execution: unknown,
): 'pass' | 'assertion-failed' | 'unknown' {
  const receipt = record(execution);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.hooksExecuted !== false ||
    receipt.unhandledErrors !== 0
  )
    return 'unknown';
  const executed = objects(receipt.tests).filter(
    (test) => test.file === file && test.name === name,
  );
  if (executed.length !== 1) return 'unknown';
  const data = record(value);
  if (data.numRuntimeErrorTestSuites !== undefined && data.numRuntimeErrorTestSuites !== 0)
    return 'unknown';
  const files = objects(data.testResults).filter((f) => f.name === file);
  if (files.length !== 1) return 'unknown';
  const tests = objects(files[0]!.assertionResults).filter((t) => t.fullName === name);
  if (tests.length !== 1) return 'unknown';
  const test = tests[0]!;
  if (test.status === 'passed' && files[0]!.status === 'passed' && executed[0]!.state === 'passed')
    return 'pass';
  if (
    test.status !== 'failed' ||
    executed[0]!.state !== 'failed' ||
    !Array.isArray(test.failureMessages) ||
    !test.failureMessages.length
  )
    return 'unknown';
  // Setup/import errors cannot stand in for the expected failing assertion.
  if (
    Array.isArray(executed[0]!.errors) &&
    executed[0]!.errors.length > 0 &&
    executed[0]!.errors.every((e) => e === 'AssertionError') &&
    test.failureMessages.every(
      (message) => typeof message === 'string' && /(?:AssertionError|ERR_ASSERTION)/.test(message),
    )
  )
    return 'assertion-failed';
  return 'unknown';
}
export function executionReceipt(output: string): unknown {
  const rows = output
    .split('\n')
    .map((line) => /^FANTASY_REGRESSION_EXECUTION=(.*)$/.exec(line)?.[1])
    .filter((line) => line !== undefined);
  ensure(rows.length === 1, 'Missing or ambiguous test-body execution receipt');
  return JSON.parse(rows[0]!);
}
export async function regression(path: string, selection: unknown) {
  return operation(path, async () => {
    const j = readJournal(path),
      view = status(j),
      dirs = owned(path, j),
      selected = record(selection);
    ensure(view.phase === 'review', 'Source must be verified first');
    const file = relativePath(selected.file),
      name = text(selected.name);
    ensure(
      isTestPath(file) &&
        file.endsWith('.test.ts') &&
        name.length <= 500 &&
        scope(dirs.workspace, j.contract).some((c) => c.path === file && c.status === 'A'),
      'Choose one newly added regression test',
    );
    const test = readFileSync(join(dirs.workspace, file), 'utf8'),
      testHash = digest(test);
    const directory = join(dirs.root, 'evidence', `regression-${view.attempts}`);
    mkdirSync(directory); // A failed proof is retained; do not silently overwrite or fabricate a retry.
    const baseline = join(dirs.root, `baseline-${view.attempts}`);
    git(dirs.root, [
      '--git-dir',
      dirs.repository,
      'worktree',
      'add',
      '--detach',
      baseline,
      j.contract.baselineSha,
    ]);
    copyDependencies(dirs.workspace, baseline);
    mkdirSync(dirname(join(baseline, file)), { recursive: true });
    writeFileSync(join(baseline, file), test, { flag: 'wx' });
    git(baseline, ['add', '--', file]);
    git(baseline, [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fantasy regression',
      '-c',
      'user.email=regression@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'test: overlay candidate regression on frozen baseline',
    ]);
    const baselineOverlaySha = git(baseline, ['rev-parse', 'HEAD']);
    const results = [];
    for (const [label, root] of [
      ['baseline', baseline],
      ['candidate', dirs.workspace],
    ] as const) {
      const output = regularPath(join(root, '.generated', 'loop-regression'));
      mkdirSync(output, { recursive: true });
      const reportPath = join(output, 'vitest.json');
      const reporterPath = regularPath(join(output, 'regression-reporter.ts'));
      writeFileSync(
        reporterPath,
        readFileSync(new URL('./regression-reporter.ts', import.meta.url)),
        { flag: 'wx' },
      );
      const command = [
        'vp',
        'test',
        'run',
        file,
        '--reporter=json',
        `--reporter=${reporterPath}`,
        `--outputFile=${reportPath}`,
        `--testNamePattern=^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      ];
      const remaining = Date.parse(view.deadline) - Date.now();
      ensure(remaining > 0, 'Deadline exceeded');
      const run = await isolatedCommand(
        root,
        dirs.repository,
        command,
        Math.min(120_000, remaining),
        [join(root, '.generated')],
        undefined,
        [reporterPath],
      );
      writeFileSync(join(directory, `${label}.log`), run.output, { flag: 'wx' });
      let report: unknown = null,
        execution: unknown = null,
        outcome = 'unknown';
      try {
        report = readBoundedJson(regularPath(reportPath));
        execution = executionReceipt(run.output);
        outcome = assertionOutcome(report, join(root, file), name, execution);
      } catch {
        /* Missing JSON is incomplete. */
      }
      if (run.bounded || run.exitCode !== (label === 'baseline' ? 1 : 0)) outcome = 'unknown';
      ensure(
        !git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
        'Regression changed tracked source',
      );
      results.push({ label, command, ...run, report, execution, outcome });
    }
    owned(path, j);
    const evidence = join(directory, 'comparison.json');
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          baselineSha: j.contract.baselineSha,
          baselineOverlaySha,
          candidateSha: view.candidateSha,
          file,
          name,
          testHash,
          results,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    ensure(
      results[0]!.outcome === 'assertion-failed' && results[1]!.outcome === 'pass',
      'No baseline assertion failure/candidate pass proof',
    );
    return status(transition(path, j, 'regression', { candidateSha: view.candidateSha, evidence }));
  });
}
