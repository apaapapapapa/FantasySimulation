import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';

const workflow = readFileSync(
  new URL('../.github/workflows/publication.yml', import.meta.url),
  'utf8',
);

it('keeps publication manual, serialized and bound to the successful main workflow source', () => {
  expect(workflow).toContain('  workflow_dispatch:');
  expect(workflow).not.toMatch(/^  (?:push|pull_request|pull_request_target|workflow_run|schedule):/m);
  expect(workflow).toContain("github.ref == 'refs/heads/main'");
  expect(workflow).toContain("github.repository == 'apaapapapapa/FantasySimulation'");
  expect(workflow).toContain('  group: r2-publication\n  cancel-in-progress: false');
  expect(workflow.match(/uses: \.\/\.github\/actions\/pages-gate/g)).toHaveLength(2);
  expect(workflow.match(/test "\$SOURCE_SHA" = "\$GITHUB_SHA"/g)).toHaveLength(2);
  expect(workflow).toContain('test "$SOURCE_SHA" = "$PREPARED_SHA"');
  expect(workflow).not.toMatch(/persist-credentials: true|secrets: inherit|permissions: write-all/);
});

it('passes production credentials only to the protected publisher, never calculation or artifacts', () => {
  const [prepare, publish] = workflow.split('\n  publish:\n');
  expect(prepare).not.toMatch(/secrets\.|environment:/);
  expect(publish).toContain('    environment: r2-publication');
  expect(publish).toContain('test "$ENABLED" = true');
  expect(workflow.match(/secrets\./g)).toHaveLength(2);
  const [beforeCredentials, credentials] = publish!.split('      - name: Restore retained data');
  expect(beforeCredentials).not.toContain('secrets.');
  expect(credentials).toContain('secrets.R2_ACCESS_KEY_ID');
  expect(credentials).toContain('secrets.R2_SECRET_ACCESS_KEY');
  expect(prepare).toContain('apps/api/.generated/cloud/output/objects/');
  expect(prepare).not.toMatch(/\.work|\.env|path: apps\/api\/\.generated\/cloud\s*$/m);
  expect(publish).toContain('artifact-ids: ${{ needs.prepare.outputs.artifact-id }}');
  expect(publish).not.toContain('run-id: ${{ inputs.artifact');
  expect(workflow).not.toMatch(/run:.*\$\{\{\s*inputs\./);
});

it('defaults to dry run and restores before export/publish without automatic deletion', () => {
  expect(workflow).toContain('default: dry-run');
  expect(workflow).toContain('args=(--dry-run)');
  expect(workflow).toContain("PUBLICATION_MAX_RESTORE_BYTES: '256000000'");
  expect(workflow.indexOf('vp run publication restore')).toBeLessThan(
    workflow.indexOf('vp run publication publish'),
  );
  expect(workflow).not.toContain('publication prune');
  expect(workflow).toContain('Planned only; no R2 writes.');
});
