import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { repository, requiredJobs, validateJobs } from '../harness/issue-completion.ts';

await test('Release overrides ancestor skips while explicitly requiring all successful gates', () => {
  const file = new URL('../../.github/workflows/ci.yml', import.meta.url);
  const release = readFileSync(file, 'utf8').split('\n  release:\n')[1];
  assert.ok(release);
  assert.ok(release.includes('needs: [verify, ci-gate, security, dependency-policy]'));
  const condition = /^    if: >-\n([\s\S]*?)^    runs-on:/m.exec(release)?.[1];
  assert.ok(condition);
  assert.equal(
    condition.trim().replace(/\s+/g, ' '),
    [
      'always()',
      '!cancelled()',
      "needs.verify.result == 'success'",
      "needs['ci-gate'].result == 'success'",
      "needs.security.result == 'success'",
      "needs['dependency-policy'].result == 'success'",
      `github.repository == '${repository}'`,
      "github.ref == 'refs/heads/main'",
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    ].join(' && '),
  );
});

await test('Issue completion still rejects unsuccessful or skipped main releases', () => {
  assert.ok(requiredJobs.includes('Release'));
  const jobs = requiredJobs
    .filter((name) => name !== 'Release')
    .map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const docs = { name: 'Docs (${{ matrix.os }})', status: 'completed', conclusion: 'skipped' };
  for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
    assert.throws(() =>
      validateJobs([...jobs, docs, { name: 'Release', status: 'completed', conclusion }]),
    );
  }
  validateJobs([...jobs, docs, { name: 'Release', status: 'completed', conclusion: 'success' }]);
});
