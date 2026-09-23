/** Real isolation/regression smoke; its disposable sample is never published or merged. */
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

const output = join(controllerRoot, '.generated/harness/loop-smoke');
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
repo.git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
copyDependencies(controllerRoot, repo.root);
const baselineSha = repo.git('rev-parse', 'HEAD').trim();
const journal = initialize(join(output, 'store'), {
  schemaVersion: 1,
  repository: 'owner/repo',
  baselineSha,
  goal: 'Disposable integration sample returns one',
  allowedPaths: ['src'],
  requiredChecks: ['source-clean', 'source-verify'],
  budget: DEFAULT_BUDGET,
  review: 'self',
  reviewWaitMs: 0,
  target: 'pr',
});
const evidence: Record<string, unknown> = {
  fixtureOnly: true,
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
      `const fs=require('node:fs');const a=require('node:assert/strict');a.equal(process.env.GH_TOKEN,undefined);a.equal(fs.existsSync(${JSON.stringify(canary)}),false);a.throws(()=>fs.writeFileSync('src/value.ts','tampered'));`,
    ],
    30_000,
  );
  evidence.isolationProbe = probe;
  assert.equal(probe.exitCode, 0, 'Real namespace/read-only isolation must work; no fallback');
  await beginAttempt(journal, {
    hypothesis: 'The sample constant should be one',
    externalCalls: 0,
    costMicros: 0,
  });
  const patch = join(output, 'sample.diff');
  writeFileSync(
    patch,
    [
      'diff --git a/src/value.ts b/src/value.ts',
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
      '@@ -1 +1 @@',
      '-export const value = 0;',
      '+export const value = 1;',
      'diff --git a/src/value.test.ts b/src/value.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/value.test.ts',
      '@@ -0,0 +1,3 @@',
      "+import { it, expect } from 'vite-plus/test';",
      "+import { value } from './value.ts';",
      "+it('returns one', () => { expect(value).toBe(1); });",
      '',
    ].join('\n'),
  );
  const candidate = await applyPatch(journal, { patch, attempt: 1, baseSha: baselineSha });
  const evaluated = await evaluate(journal);
  evidence.evaluation = evaluated;
  assert.equal(evaluated.phase, 'review');
  evidence.regression = await regression(journal, {
    file: 'src/value.test.ts',
    name: 'returns one',
  });
  // This exercises receipt handling for the sample only; it is not an independent human approval.
  assert.equal(
    readFileSync(join(dirs.workspace, 'src/value.ts'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.match(
    readFileSync(join(dirs.workspace, 'src/value.test.ts'), 'utf8'),
    /expect\(value\)\.toBe\(1\)/,
  );
  await review(journal, {
    candidateSha: candidate.candidateSha,
    completedAt: new Date().toISOString(),
    method: 'self',
    reviewedPaths: ['src/value.ts', 'src/value.test.ts'],
    unresolvedFindings: 0,
    summary:
      'Integration fixture inspection: only constant and independent assertion changed; this is not human approval.',
  });
  evidence.handoff = handoff(journal);
  assert.equal(repo.git('rev-parse', 'HEAD').trim(), baselineSha);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(readFileSync(join(repo.root, 'src/value.ts'), 'utf8'), 'export const value = 0;\n');
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
