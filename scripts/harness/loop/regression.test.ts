import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { runCommand, safeEnvironment } from '../process.ts';
import { testRepository } from '../test-support/repository.ts';
import { assertionOutcome, executionReceipt } from './regression.ts';
import { controllerRoot } from './workspace.ts';

it.each([
  ['body fails', 'assertion-failed'],
  ['body passes', 'pass'],
  ['setup blocked body', 'unknown'],
  ['teardown passing body', 'unknown'],
])(
  'uses real Vitest execution to classify %s',
  async (name, expected) => {
    const repo = testRepository({
      'package.json': '{"type":"module","packageManager":"pnpm@11.19.0"}',
      'vite.config.ts': "export default { test: { include: ['proof.test.ts'] } };",
      'proof.test.ts': `import { it, describe, expect, beforeEach, afterEach } from 'vite-plus/test';
it('body fails', () => { expect(0).toBe(1); });
it('body passes', () => { expect(1).toBe(1); });
describe('setup', () => {
  beforeEach(() => { expect(0).toBe(1); });
  it('blocked body', () => { throw new Error('Body must not execute'); });
});
describe('teardown', () => {
  afterEach(() => { expect(0).toBe(1); });
  it('passing body', () => { expect(1).toBe(1); });
});`,
    });
    try {
      symlinkSync(join(controllerRoot, 'node_modules'), join(repo.root, 'node_modules'));
      const report = join(repo.root, '.generated/result.json');
      const run = await runCommand(
        join(controllerRoot, 'node_modules/.bin/vp'),
        [
          'test',
          'run',
          'proof.test.ts',
          '--reporter=json',
          `--reporter=${join(controllerRoot, 'scripts/harness/loop/regression-reporter.ts')}`,
          `--outputFile=${report}`,
          `--testNamePattern=^${name}$`,
        ],
        repo.root,
        { env: safeEnvironment(process.env), timeoutMs: 30_000 },
      );
      expect(run.bounded).toBe(false);
      expect(run.exitCode).toBe(expected === 'pass' ? 0 : 1);
      expect(
        assertionOutcome(
          JSON.parse(readFileSync(report, 'utf8')),
          join(repo.root, 'proof.test.ts'),
          name,
          executionReceipt(run.output),
        ),
      ).toBe(expected);
    } finally {
      repo.dispose();
    }
  },
  40_000,
);
