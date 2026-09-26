import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';

const workflow = readFileSync(new URL('../.github/workflows/league.yml', import.meta.url), 'utf8');
it('runs once daily on tested main, skips unchanged inputs and keeps manual dry-run write-free', () => {
  expect(workflow.match(/cron:/g)).toHaveLength(1);
  expect(workflow).toContain("cron: '17 3 * * *'");
  expect(workflow).toContain(
    "github.repository == 'apaapapapapa/FantasySimulation' && github.ref == 'refs/heads/main'",
  );
  expect(workflow).not.toMatch(
    /pull_request_target|secrets: inherit|persist-credentials: true|permissions: write-all/,
  );
  expect(workflow).toContain('group: r2-publication\n  cancel-in-progress: false');
  expect(workflow).toContain('default: dry-run');
  expect(workflow).toContain(
    "LEAGUE_MODE: ${{ github.event_name == 'schedule' && 'schedule' || inputs.mode }}",
  );
  expect(workflow).toContain('OFFICIAL_LEAGUE_DEFINITION: data/leagues/official-20-v1.json');
  expect(workflow).toContain('name: league-probe-${{ github.run_id }}-${{ github.run_attempt }}');
  expect(workflow).toContain(
    "needs.probe.outputs.needed == 'true' && (github.event_name == 'schedule' || inputs.mode == 'publish')",
  );
  const probe = workflow.split('\n  prepare:')[0]!;
  expect(probe).not.toMatch(/secrets\.|environment:/);
  expect(workflow.match(/league-phase: start/g)).toHaveLength(2);
  expect(workflow).toContain('league-phase: finish');
});
it('admits workers only after durable publication and isolates secrets from simulation/artifacts', () => {
  const compute = workflow.split('\n  compute:')[1]!.split('\n  publish:')[0]!;
  expect(compute).not.toMatch(/secrets\.|R2_|environment:/);
  expect(compute).toContain('max-parallel: 4');
  expect(compute).toContain('fail-fast: false');
  expect(workflow.indexOf('league-cloud.ts admit')).toBeLessThan(
    workflow.indexOf('operation: prepare'),
  );
  expect(workflow).toContain("if: always() && !cancelled() && needs.prepare.result == 'success'");
  expect(workflow.match(/environment: r2-publication/g)).toHaveLength(2);
  const secretSteps = workflow.split(/\n      - /).filter((step) => step.includes('secrets.'));
  expect(secretSteps).toHaveLength(3);
  for (const step of secretSteps) {
    expect(step).toMatch(/run: node --import tsx src\/league-cloud\.ts (?:restore|admit|publish) /);
    expect(step).not.toMatch(/uses:|league-cloud\.ts (?:prepare|run|finish)/);
  }
  expect(workflow).not.toMatch(/run:.*\$\{\{\s*(?:inputs|matrix)\./);
});

it('retains safe failure reports from every job without uploading raw diagnostics', () => {
  for (const job of ['probe', 'prepare', 'compute']) {
    const steps = workflow.split(`\n  ${job}:`)[1]!.split(/\n  [a-z]+:/)[0]!;
    expect(steps).toContain('if: failure()');
    expect(steps).toContain('path: apps/cli/.generated/league/reports/failure-*.json');
    expect(steps).not.toMatch(/path:.*(?:\.log|\*\*)/);
  }
  expect(workflow.split('\n  publish:')[1]).toContain('apps/cli/.generated/league/reports/*.json');
});

it('recovers saved results on tested main with fresh leases and no simulation or admission', () => {
  const recovery = readFileSync(
    new URL('../.github/workflows/league-recovery.yml', import.meta.url),
    'utf8',
  );
  expect(recovery).toContain("github.ref == 'refs/heads/main'");
  expect(recovery).toContain('group: r2-publication\n  cancel-in-progress: false');
  expect(recovery).toContain('environment: r2-publication');
  expect(recovery).toContain('league-phase: start');
  expect(recovery).toContain('league-phase: finish');
  expect(recovery).toContain('operation: recover');
  expect(recovery).toContain('timeout-minutes: 180');
  const artifacts = readFileSync(
    new URL('../.github/actions/league-artifacts/action.yml', import.meta.url),
    'utf8',
  );
  expect(artifacts).toContain('timeout: leagueArtifactTimeout(env.LEAGUE_ARTIFACT_OPERATION)');
  expect(recovery).not.toMatch(
    /league-cloud\.ts (?:prepare|run|admit)|schedule:|persist-credentials: true/,
  );
  const secretSteps = recovery.split(/\n      - /).filter((step) => step.includes('secrets.'));
  expect(secretSteps).toHaveLength(1);
  expect(secretSteps[0]).toContain('run: node --import tsx src/league-cloud.ts publish');
  expect(secretSteps[0]).not.toContain('uses:');
  expect(recovery).not.toMatch(/(?:^|\n)\s+run:.*\$\{\{\s*inputs\./);
});
