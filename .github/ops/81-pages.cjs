module.exports = async ({ github, context, core }) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs/promises');
  const repo = { owner: 'apaapapapapa', repo: 'FantasySimulation' };
  const baseline = 'd0b32d0cccc74d6f5ccf0c26fcb1fa32a13671f5';
  const rollback = process.env.ACCEPTANCE_PHASE === 'rollback';
  const sourceSha = process.env.EXPECTED_VIEWER_SHA;
  const ciRunId = Number(process.env.CI_RUN_ID);
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Do not redispatch this broker by rerunning');
  const ci = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: ciRunId })).data;
  assert.equal(ci.head_sha, sourceSha);
  assert.equal(ci.head_branch, 'main');
  assert.equal(ci.path, '.github/workflows/ci.yml');
  assert.equal(ci.event, 'push');
  assert.equal(ci.conclusion, 'success');
  if (rollback) {
    const main = (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data;
    assert.equal(main.commit.sha, baseline, 'Main changed before acceptance');
    const build = await fetch('https://apaapapapapa.github.io/FantasySimulation/build.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) }).then(r => r.json());
    assert.equal(build.sourceSha, baseline);
  }
  const listing = { ...repo, workflow_id: 'pages.yml', event: 'workflow_dispatch', branch: 'main', per_page: 100 };
  const before = new Set((await github.rest.actions.listWorkflowRuns(listing)).data.workflow_runs.map(r => r.id));
  const started = Date.now();
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'pages.yml', ref: 'main', inputs: { ci_run_id: String(ciRunId) } });
  let run;
  for (let i = 0; i < 40; i++) {
    const candidates = (await github.rest.actions.listWorkflowRuns(listing)).data.workflow_runs.filter(r => !before.has(r.id) && r.actor?.login === 'github-actions[bot]' && Date.parse(r.created_at) >= started - 2000);
    assert.ok(candidates.length <= 1, 'Ambiguous dispatch; inspect without repeating the mutation');
    run = candidates[0];
    if (run?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  const evidence = { phase: process.env.ACCEPTANCE_PHASE, sourceSha, ciRunId, ciAttempt: ci.run_attempt, runId: run?.id, attempt: run?.run_attempt, conclusion: run?.conclusion, url: run?.html_url };
  console.log('PAGES_ACCEPTANCE_DEPLOY=' + JSON.stringify(evidence));
  await fs.mkdir('.generated/activation-browser', { recursive: true });
  await fs.writeFile('.generated/activation-browser/deploy.json', JSON.stringify(evidence, null, 2));
  assert.equal(run?.conclusion, 'success', 'Pages deployment must succeed');
  let build;
  for (let i = 0; i < 30; i++) {
    const response = await fetch('https://apaapapapapa.github.io/FantasySimulation/build.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      build = await response.json();
      if (build.sourceSha === sourceSha) break;
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  assert.equal(build?.sourceSha, sourceSha, 'The actual served viewer must match the requested CI source');
  await core.summary.addHeading('Pages ' + evidence.phase).addRaw(JSON.stringify({ ...evidence, build }, null, 2)).write();
};
