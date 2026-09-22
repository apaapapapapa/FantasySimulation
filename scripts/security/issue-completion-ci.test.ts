import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredJobs, validateJobs } from '../harness/issue-completion.ts';

const plannedDocs = {
  name: 'Docs (${{ matrix.os }})',
  status: 'completed',
  conclusion: 'skipped',
};
const passedJobs = () =>
  requiredJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

await test('full main CI permits only the non-expanded docs matrix to be skipped', () => {
  validateJobs([...passedJobs(), plannedDocs]);
});

await test('the current CI planner and aggregate gate are mandatory successful checks', () => {
  for (const name of ['changes', 'ci-gate']) {
    assert.ok(requiredJobs.includes(name));
    const other = passedJobs().filter((job) => job.name !== name);
    assert.throws(() => validateJobs([...other, plannedDocs]));
    for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
      const job = { name, status: 'completed', conclusion };
      assert.throws(() => validateJobs([...other, job, plannedDocs]));
    }
  }
});

await test('docs failure, duplicate jobs and any unplanned skip still block completion', () => {
  const jobs = passedJobs();
  for (const conclusion of ['failure', 'cancelled', null]) {
    assert.throws(() => validateJobs([...jobs, { ...plannedDocs, conclusion }]));
  }
  for (const name of ['Unexpected check', 'Docs (ubuntu-latest)', 'Docs (windows-latest)']) {
    assert.throws(() => validateJobs([...jobs, { ...plannedDocs, name }]));
  }
  assert.throws(() => validateJobs([...jobs, plannedDocs, plannedDocs]));
  assert.throws(() => validateJobs([...jobs, { ...plannedDocs, status: 'in_progress' }]));
});
