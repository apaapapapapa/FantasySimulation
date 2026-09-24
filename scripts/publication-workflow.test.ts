import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';

const workflowPath = new URL('../.github/workflows/publication.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');

it('requires manual, serialized publication from tested main', () => {
  const automatic = /^  (?:push|pull_request|pull_request_target|workflow_run|schedule):/m;
  const privileged = /persist-credentials: true|secrets: inherit|permissions: write-all/;
  expect(workflow).toContain('  workflow_dispatch:');
  expect(workflow).not.toMatch(automatic);
  expect(workflow).toContain("github.ref == 'refs/heads/main'");
  expect(workflow).toContain("github.repository == 'apaapapapapa/FantasySimulation'");
  expect(workflow).toContain('  group: r2-publication\n  cancel-in-progress: false');
  expect(workflow.match(/uses: \.\/\.github\/actions\/pages-gate/g)).toHaveLength(2);
  expect(workflow.match(/test "\$SOURCE_SHA" = "\$GITHUB_SHA"/g)).toHaveLength(2);
  expect(workflow).toContain('test "$SOURCE_SHA" = "$PREPARED_SHA"');
  expect(workflow).not.toMatch(privileged);
});

it('isolates production credentials from calculation and artifacts', () => {
  const [prepare, publish] = workflow.split('\n  publish:\n');
  expect(prepare).not.toMatch(/secrets\.|environment:/);
  expect(publish).toContain('    environment: r2-publication');
  expect(publish).toContain('test "$ENABLED" = true');
  expect(workflow.match(/secrets\./g)).toHaveLength(2);
  const step = '      - name: Restore retained data';
  const [beforeCredentials, credentials] = publish!.split(step);
  expect(beforeCredentials).not.toContain('secrets.');
  expect(credentials).toContain('secrets.R2_ACCESS_KEY_ID');
  expect(credentials).toContain('secrets.R2_SECRET_ACCESS_KEY');
  expect(prepare).toContain('apps/api/.generated/cloud/output/objects/');
  expect(prepare).not.toMatch(/\.work|\.env|path: apps\/api\/\.generated\/cloud\s*$/m);
  expect(publish).toContain('artifact-ids: ${{ needs.prepare.outputs.artifact-id }}');
  expect(publish).not.toContain('run-id: ${{ inputs.artifact');
  expect(workflow).not.toMatch(/run:.*\$\{\{\s*inputs\./);
});

it('defaults to dry run and restores before publishing without deletion', () => {
  expect(workflow).toContain('default: dry-run');
  expect(workflow).toContain('args=(--dry-run)');
  expect(workflow).toContain("PUBLICATION_MAX_RESTORE_BYTES: '256000000'");
  expect(workflow.indexOf('vp run publication restore')).toBeLessThan(
    workflow.indexOf('vp run publication publish'),
  );
  expect(workflow).not.toContain('publication prune');
  expect(workflow).toContain('Planned only; no R2 writes.');
});
