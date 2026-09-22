import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedBody, issueTasks } from '../harness/issue-completion.ts';
import type { Completion } from '../harness/issue-completion.ts';

const plan: Completion = {
  schemaVersion: 1,
  issue: 25,
  issueBodySha256: 'a'.repeat(64),
  issueUpdatedAt: '2026-09-22T00:00:00Z',
  complete: true,
  summary: 'Reviewed all tasks.',
  remainingWork: [],
  pullRequests: [29],
  acceptance: [{ task: 'Implementation', evidence: 'Implementation tests passed.' }],
};

await test('inline HTML comments cannot hide an incomplete acceptance item', () => {
  const body = '- [ ] Implementation\n- [ ] External setup <!-- still required -->';
  assert.deepEqual(
    issueTasks(body).map((item) => item.task),
    ['Implementation', 'External setup'],
  );
  assert.throws(() => completedBody(plan, body, 'a'.repeat(40), 100), /UNCOVERED_ISSUE_TASKS/);
});

await test('visible checkboxes are updated without modifying adjacent comments', () => {
  const body = '- [ ] Implementation <!-- [ ] internal note -->';
  const result = completedBody(plan, body, 'a'.repeat(40), 100);
  assert.ok(result.startsWith('- [x] Implementation <!-- [ ] internal note -->'));
});

await test('quoted tasks are covered and checked, not silently ignored', () => {
  const body = '> - [ ] Implementation\n> - [ ] External setup';
  assert.equal(issueTasks(body).length, 2);
  assert.throws(() => completedBody(plan, body, 'a'.repeat(40), 100), /UNCOVERED_ISSUE_TASKS/);
  assert.ok(
    completedBody(plan, '> - [ ] Implementation', 'a'.repeat(40), 100).startsWith(
      '> - [x] Implementation',
    ),
  );
});

await test('comment-like text inside a fenced example does not hide following real tasks', () => {
  const body = '```md\n<!-- example text\n```\n- [ ] Implementation';
  assert.deepEqual(
    issueTasks(body).map((item) => item.task),
    ['Implementation'],
  );
  assert.equal(issueTasks('~~~\n- [ ] example\n~~~\n- [ ] Implementation').length, 1);
});

await test('ambiguous comment-prefixed tasks fail closed instead of editing the wrong checkbox', () => {
  assert.throws(
    () => issueTasks('<!-- [ ] example --> - [ ] Implementation'),
    /UNSUPPORTED_ISSUE_TASK_MARKUP/,
  );
  assert.throws(() => issueTasks('<!-- unclosed'), /UNTERMINATED_ISSUE_MARKUP/);
});

await test('completion evidence escapes Markdown and HTML without creating extra lines', () => {
  const raw = '&<>@`[]*_\r\nnext';
  const escaped = '&#38;&#60;&#62;&#64;&#96;&#91;&#93;&#42;&#95; next';
  const result = completedBody(
    {
      ...plan,
      summary: raw,
      acceptance: [{ task: raw, evidence: raw }],
    },
    'No checklist.',
    'a'.repeat(40),
    100,
  );
  assert.ok(result.includes(`\n${escaped}\n`));
  assert.ok(result.includes(`- [x] ${escaped} — ${escaped}\n`));
  assert.ok(!result.includes(raw));
});
