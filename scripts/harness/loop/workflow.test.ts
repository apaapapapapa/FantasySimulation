import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';
it('keeps automatic CI intake read-only and on trusted main without upstream artifacts or repair', () => {
  const workflow = readFileSync('.github/workflows/ci-intake.yml', 'utf8');
  expect(workflow).toContain('workflow_run:');
  expect(workflow).toContain("github.event.workflow_run.event == 'push'");
  expect(workflow).toContain('ref: main');
  expect(workflow).toContain('persist-credentials: false');
  expect(workflow).toContain('contents: read');
  expect(workflow).toContain('actions: read');
  expect(workflow).not.toMatch(
    /(?:contents|actions|issues|pull-requests): write|download-artifact|cache: true|loop (?:begin|apply|evaluate)|git push|pull_request_target/,
  );
  const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
  expect(secrets).toEqual(['GITHUB_TOKEN']);
});
