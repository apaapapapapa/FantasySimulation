/** Real isolation/regression smoke; publication proofs remain disposable, never merged. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testRepository } from '../test-support/repository.ts';
import { DEFAULT_BUDGET } from './contract.ts';
import { initialize, readJournal } from './journal.ts';
import {
  applyPatch,
  beginAttempt,
  controllerRoot,
  copyDependencies,
  locations,
  prepare,
} from './workspace.ts';
import { evaluate, isolatedCommand } from './evaluation.ts';
import { regression } from './regression.ts';
import { handoff, review } from './handoff.ts';
import { status } from './state.ts';
import { git } from '../source.ts';
import { sha } from '../report.ts';

const repositoryProof = process.argv[2] === 'repository';
const published = process.argv.length === 5 && repositoryProof;
assert(process.argv.length === 2 || (process.argv.length === 3 && repositoryProof) || published);
const frozenBaseline = published ? sha(process.argv[3]) : null;
const frozenCandidate = published ? sha(process.argv[4]) : null;
const output = join(
  controllerRoot,
  `.generated/harness/${repositoryProof ? 'repository-loop-proof' : 'loop-smoke'}`,
);
mkdirSync(output, { recursive: true });
const repo = testRepository({
  '.gitignore': '.generated/\nnode_modules/\n',
  'package.json': JSON.stringify({
    name: 'loop-smoke',
    type: 'module',
    private: true,
    packageManager: 'pnpm@11.19.0',
    scripts: { verify: 'vp test run' },
    devDependencies: { 'vite-plus': '0.3.3' },
  }),
  'vite.config.ts':
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { include: ['src/*.test.ts'] } });\n",
  'src/value.ts': 'export const value = 0;\n',
});
const repository = repositoryProof ? 'apaapapapapa/FantasySimulation' : 'owner/repo';
if (repositoryProof) {
  const baseline = frozenBaseline ?? git(controllerRoot, ['rev-parse', 'HEAD']);
  if (published) {
    repo.git('fetch', `https://github.com/${repository}.git`, baseline, frozenCandidate!);
    assert.equal(repo.git('show', '-s', '--format=%P', frozenCandidate!).trim(), baseline);
    assert.equal(
      repo.git('show', '-s', '--format=%B', frozenCandidate!).trim(),
      'fix: manual repair attempt 1',
    );
  } else repo.git('fetch', controllerRoot, baseline);
  repo.git('reset', '--hard', baseline);
  if (!published) {
    writeFileSync(join(repo.root, 'apps/api/src/loop-proof-value.ts'), 'export const value = 0;\n');
    repo.git('add', 'apps/api/src/loop-proof-value.ts');
    repo.git('commit', '-m', 'test: add an isolated repair proof fixture');
  }
}
repo.git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
copyDependencies(controllerRoot, repo.root);
const baselineSha = repo.git('rev-parse', 'HEAD').trim();
const file = repositoryProof ? 'apps/api/src/loop-proof-value.ts' : 'src/value.ts';
const testFile = repositoryProof ? 'apps/api/src/loop-proof-value.test.ts' : 'src/value.test.ts';
const testName = 'returns one';
const original = readFileSync(join(repo.root, file), 'utf8');
assert.equal(original, 'export const value = 0;\n');
const candidateText = 'export const value = 1;\n';
const testText = `import { it, expect } from 'vite-plus/test';
import { value } from './${repositoryProof ? 'loop-proof-value' : 'value'}.ts';
it('${testName}', () => {
  expect(value).toBe(1);
});
`;
function diff(path: string, before: string | null, after: string) {
  const old = before === null ? [] : before.slice(0, -1).split('\n');
  const next = after.slice(0, -1).split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ['new file mode 100644'] : []),
    `--- ${before === null ? '/dev/null' : 'a/' + path}`,
    `+++ b/${path}`,
    `@@ -${old.length ? '1,' + old.length : '0,0'} +1,${next.length} @@`,
    ...old.map((line) => '-' + line),
    ...next.map((line) => '+' + line),
    '',
  ].join('\n');
}
const journal = initialize(join(output, 'store'), {
  schemaVersion: 1,
  repository,
  baselineSha,
  goal: repositoryProof
    ? 'Full repository integration sample returns one'
    : 'Disposable integration sample returns one',
  allowedPaths: [file, testFile],
  requiredChecks: ['source-clean', 'source-verify'],
  budget: DEFAULT_BUDGET,
  review: 'self',
  reviewWaitMs: 0,
  target: 'pr',
});
const evidence: Record<string, unknown> = {
  fixtureOnly: true,
  repositoryProof,
  sourceMainSha: repositoryProof ? git(controllerRoot, ['rev-parse', 'origin/main']) : null,
  sourceControllerSha: git(controllerRoot, ['rev-parse', 'HEAD']),
  frozenCandidate,
  repairedProduction: false,
  baselineSha,
  journal,
  steps: [],
};
try {
  await prepare(journal, repo.root);
  const dirs = locations(journal);
  const canary = join(output, 'host-only.txt');
  writeFileSync(canary, 'host-only fixture');
  const probe = await isolatedCommand(
    dirs.workspace,
    dirs.repository,
    [
      process.execPath,
      '-e',
      "const fs=require('node:fs');const a=require('node:assert/strict');a.equal(process.env.GH_TOKEN,undefined);a.equal(fs.existsSync(process.argv[1]),false);a.throws(()=>fs.writeFileSync(process.argv[2],'tampered'));",
      canary,
      file,
    ],
    30_000,
  );
  evidence.isolationProbe = probe;
  assert.equal(probe.exitCode, 0, 'Real namespace/read-only isolation must work; no fallback');
  await beginAttempt(journal, {
    hypothesis: 'The deliberately injected sample constant should be one',
    externalCalls: published ? 200 : 0,
    costMicros: 0,
  });
  const patch = join(output, 'sample.diff');
  writeFileSync(patch, diff(file, original, candidateText) + diff(testFile, null, testText));
  // Reproduce a connector-created Git object, without replacing any journal SHA after testing.
  // Only author/committer metadata is supplied; applyPatch still owns patch/scope validation.
  const keys = [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
  ];
  const previous = keys.map((key) => process.env[key]);
  const metadata = frozenCandidate
    ? repo
        .git('show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', frozenCandidate)
        .trimEnd()
        .split('\0')
    : null;
  let candidate;
  try {
    if (metadata) {
      assert.equal(metadata.length, keys.length);
      keys.forEach((key, i) => {
        process.env[key] = metadata[i];
      });
    }
    candidate = await applyPatch(journal, { patch, attempt: 1, baseSha: baselineSha });
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
  if (frozenCandidate)
    assert.equal(
      candidate.candidateSha,
      frozenCandidate,
      'Exact Git object must match before evaluation',
    );
  const evaluated = await evaluate(journal);
  evidence.evaluation = evaluated;
  assert.equal(evaluated.phase, 'review');
  evidence.regression = await regression(journal, {
    file: testFile,
    name: testName,
  });
  // This exercises receipt handling for the sample only; it is not an independent human approval.
  assert.equal(readFileSync(join(dirs.workspace, file), 'utf8'), candidateText);
  assert.equal(readFileSync(join(dirs.workspace, testFile), 'utf8'), testText);
  await review(journal, {
    candidateSha: candidate.candidateSha,
    completedAt: new Date().toISOString(),
    method: 'self',
    reviewedPaths: [file, testFile],
    unresolvedFindings: 0,
    summary:
      'Integration profile inspection: exact proposed source and independent assertion checked; this is not independent human approval.',
  });
  evidence.handoff = handoff(journal);
  assert.equal(repo.git('rev-parse', 'HEAD').trim(), baselineSha);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(readFileSync(join(repo.root, file), 'utf8'), original);
  if (repositoryProof) {
    const bundle = join(dirs.root, 'evidence', 'candidate.bundle');
    git(dirs.workspace, ['bundle', 'create', bundle, 'HEAD']);
    evidence.candidateBundle = bundle;
  }
  evidence.status = 'pass';
} catch (error) {
  evidence.status = 'unknown';
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 2;
} finally {
  evidence.journalState = status(readJournal(journal));
  writeFileSync(join(output, 'smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
