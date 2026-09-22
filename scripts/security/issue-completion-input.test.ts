import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { completeIssues } from '../harness/issue-completion-api.ts';
import { repository } from '../harness/issue-completion.ts';

for (const scenario of ['oversized', 'invalid-json', 'directory', 'missing'] as const) {
  await test(`completion rejects ${scenario} input before any GitHub request`, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'fantasy-issue-input-'));
    const file = join(root, 'event.json');
    const keys = ['GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH'];
    const original = keys.map((key) => [key, process.env[key]] as const);
    const request = context.mock.method(globalThis, 'fetch', () => {
      throw new Error('Unexpected GitHub request');
    });
    try {
      process.env.GITHUB_REPOSITORY = repository;
      process.env.GITHUB_EVENT_NAME = 'workflow_run';
      process.env.GITHUB_EVENT_PATH = scenario === 'directory' ? root : file;
      if (scenario === 'oversized') writeFileSync(file, `"${'x'.repeat(8 * 1024 * 1024)}"`);
      if (scenario === 'invalid-json') writeFileSync(file, 'not-json');
      await assert.rejects(() => completeIssues(root, true));
      assert.equal(request.mock.callCount(), 0);
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
