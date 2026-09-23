import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assessReport, record, type Report } from '../harness/report.ts';
import { readBoundedJson } from '../harness/files.ts';
import { git, sourceIdentity } from '../harness/source.ts';
import { runCommand } from '../harness/process.ts';
import { bytesHash } from '../harness/load-contract.ts';
import { parsePlan, type Plan } from './plan.ts';
import { sharedTests, TEST_SHARDS } from './tests.ts';

export const TEST_TASKS = Array.from({ length: TEST_SHARDS }, (_, index) => `tests-${index + 1}`);
export const SOURCE_TASKS = ['static', ...TEST_TASKS, 'build', 'corpus'];
export const SOURCE_JOBS = SOURCE_TASKS.map((task) =>
  task === 'corpus' ? 'Corpus (ubuntu-latest)' : `Source (${task})`,
);
export const SOURCE_MATRIX_JOB = 'Source (${{ matrix.task }})';
export function taskCommand(task: string): string[] {
  if (task === 'static') return ['node', 'scripts/ci/verify.ts', 'static'];
  if (task === 'build') return ['vp', 'run', 'build'];
  if (TEST_TASKS.includes(task))
    return ['node', 'scripts/ci/tests.ts', task.slice(-1), String(TEST_SHARDS)];
  if (task === 'corpus')
    return [
      'node',
      'scripts/harness.ts',
      'corpus',
      'packages/engine/fixtures/spatial/corpus.json',
      '--tests',
      String(TEST_SHARDS),
    ];
  throw new Error('Unknown verification task');
}
export function expectedTasks(plan: Plan) {
  return SOURCE_TASKS.filter((task) => task !== 'corpus' || plan.simulation);
}
const runIdentity = () => ({
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
});
/** Execute the existing canonical verify commands; tests/corpus/load/build have their own CI proofs. */
async function staticChecks(root: string) {
  const pkg = record(readBoundedJson(join(root, 'package.json')));
  const scripts = record(pkg.scripts);
  if (typeof scripts.verify !== 'string') throw new Error('Missing canonical verify command');
  const commands = scripts.verify.split(' && ');
  const separate = ['vp test', 'vp run check:corpus', 'vp run check:load', 'vp run build'];
  if (
    !separate.every((command) => commands.includes(command)) ||
    !commands.every((command) => /^vp [\w: -]+$/.test(command))
  )
    throw new Error('Unsupported canonical verify task graph');
  for (const command of commands.filter((command) => !separate.includes(command))) {
    const [program, ...args] = command.split(' ');
    const result = await runCommand(program!, args, root);
    process.stdout.write(result.output);
    if (result.exitCode !== 0 || result.bounded)
      throw new Error(`Canonical task failed: ${command}`);
  }
}
export function assessTasks(plan: Plan, receipts: unknown[], run = runIdentity()) {
  const tasks = expectedTasks(plan);
  const rows = receipts.map(record);
  if (!isDeepStrictEqual(rows.map((row) => row.task).sort(), [...tasks].sort()))
    throw new Error('Missing, extra or duplicate source task');
  return rows.map((row) => {
    const task = String(row.task);
    const assessment = assessReport(row.report, ['source-clean', 'source-verify']);
    const report = assessment.report;
    if (
      assessment.exitCode !== 0 ||
      report.producer !== 'source-task' ||
      report.sourceSha !== plan.sourceSha ||
      report.candidateSha !== plan.candidateSha ||
      report.testMergeSha !== plan.testMergeSha ||
      (plan.testMergeSha !== null && report.baselineSha !== plan.baselineSha) ||
      !isDeepStrictEqual(row.command, taskCommand(task)) ||
      row.runId !== run.runId ||
      row.runAttempt !== run.runAttempt ||
      row.exitCode !== 0 ||
      row.bounded !== false ||
      typeof row.logHash !== 'string'
    )
      throw new Error('Stale or unsuccessful source task');
    return { task, startedAt: report.startedAt, finishedAt: report.finishedAt };
  });
}
async function phase(root: string, task: string) {
  const info = sourceIdentity(root),
    startedAt = new Date().toISOString();
  const cleanBefore = !git(root, ['status', '--porcelain']);
  const command = taskCommand(task);
  const result = cleanBefore ? await runCommand(command[0]!, command.slice(1), root) : null;
  const cleanAfter =
    cleanBefore &&
    !git(root, ['status', '--porcelain']) &&
    git(root, ['rev-parse', 'HEAD']) === info.sourceSha;
  const directory = join(root, '.generated/harness/tasks', task);
  mkdirSync(directory, { recursive: true });
  const output = result?.output ?? 'Task not run: dirty checkout.\n';
  writeFileSync(join(directory, 'command.log'), output);
  process.stdout.write(output);
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'source-task',
    startedAt,
    finishedAt: new Date().toISOString(),
    checks: [
      {
        id: 'source-clean',
        required: true,
        status: cleanAfter ? 'pass' : 'fail',
        reason: 'Exact clean committed source before and after task',
        evidence: [
          { uri: `.generated/harness/tasks/${task}/command.log`, sourceSha: info.sourceSha },
        ],
      },
      {
        id: 'source-verify',
        required: true,
        status: result?.exitCode === 0 && !result.bounded ? 'pass' : 'fail',
        reason: `${task}: exit=${result?.exitCode ?? 'not run'}`,
        evidence: [
          { uri: `.generated/harness/tasks/${task}/command.log`, sourceSha: info.sourceSha },
        ],
      },
    ],
  };
  writeFileSync(
    join(directory, 'receipt.json'),
    JSON.stringify(
      {
        task,
        command,
        ...runIdentity(),
        exitCode: result?.exitCode ?? null,
        bounded: result?.bounded ?? true,
        logHash: bytesHash(output),
        report,
      },
      null,
      2,
    ) + '\n',
  );
  return assessReport(report, ['source-clean', 'source-verify']).exitCode;
}
function aggregate(root: string) {
  const plan = parsePlan(readBoundedJson(join(root, '.generated/harness/ci/plan.json')));
  const info = sourceIdentity(root);
  if (plan.sourceSha !== info.sourceSha || git(root, ['status', '--porcelain']))
    throw new Error('Wrong or dirty source aggregate');
  const receipts = expectedTasks(plan).map((task) => {
    const directory = join(root, '.generated/harness/tasks', task);
    const receipt = record(readBoundedJson(join(directory, 'receipt.json')));
    if (receipt.logHash !== bytesHash(readFileSync(join(directory, 'command.log'))))
      throw new Error('Corrupt task log');
    return receipt;
  });
  const tasks = assessTasks(plan, receipts);
  sharedTests(root, TEST_SHARDS);
  const directory = join(root, '.generated/harness/source');
  mkdirSync(directory, { recursive: true });
  const startedAt = tasks.map((task) => task.startedAt).sort()[0]!,
    finishedAt = new Date().toISOString();
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'source-runner',
    startedAt,
    finishedAt,
    checks: [
      {
        id: 'source-clean',
        required: true,
        status: 'pass',
        reason: 'Every planned task ran on this clean unchanged source',
        evidence: [{ uri: '.generated/harness/source/command.json', sourceSha: info.sourceSha }],
      },
      {
        id: 'source-verify',
        required: true,
        status: 'pass',
        reason:
          'All planned canonical verification tasks and complete test inventory passed; load evidence is independently required by ci-gate',
        evidence: expectedTasks(plan).map((task) => ({
          uri: `.generated/harness/tasks/${task}/receipt.json`,
          sourceSha: info.sourceSha,
        })),
      },
    ],
  };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(
    join(directory, 'command.json'),
    JSON.stringify(
      {
        ...info,
        command: ['node', 'scripts/ci/verify.ts', 'aggregate'],
        startedAt,
        finishedAt,
        exitCode: 0,
        signal: null,
        bounded: false,
        cleanBefore: true,
        cleanAfter: true,
        tasks,
        receipts,
        plan,
        ...runIdentity(),
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(directory, 'verify.log'),
    tasks.map((task) => `${task.task}: ${task.startedAt}..${task.finishedAt}`).join('\n') + '\n',
  );
  console.log(`FANTASY_SOURCE_REPORT=${JSON.stringify(report)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, task] = process.argv.slice(2);
    if (command === 'phase' && task) process.exitCode = await phase(process.cwd(), task);
    else if (command === 'static' && !task) await staticChecks(process.cwd());
    else if (command === 'aggregate' && !task) aggregate(process.cwd());
    else throw new Error('Invalid source task command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Incomplete source tasks');
    process.exitCode = 2;
  }
}
