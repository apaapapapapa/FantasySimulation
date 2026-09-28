import { vi } from 'vite-plus/test';
import { artifactZip } from './league-zip.ts';
import { archiveHash } from '../league-archive.ts';

export function pipelineActionsFixture() {
  const identity = {
    source: {
      sha: 'a'.repeat(40),
      node: process.versions.node,
      platform: 'linux' as const,
      arch: 'x64' as const,
    },
    runId: 123,
    runAttempt: 1,
    validatorDigest: 'sha256:' + 'b'.repeat(64),
  };
  const zip = artifactZip('control.json', Buffer.from('exact bytes'));
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: identity.source.sha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    path: '.github/workflows/league-pipeline.yml',
    head_repository: { full_name: 'apaapapapapa/FantasySimulation' },
    status: 'in_progress',
    conclusion: null,
  };
  const artifact = {
    id: 456,
    name: 'league-123-1-inputs',
    digest: archiveHash(zip),
    size_in_bytes: zip.length,
    expired: false,
    workflow_run: { id: 123, head_sha: identity.source.sha },
  };
  const jobs = ['admit', 'compute (0)'].map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    head_sha: identity.source.sha,
    run_attempt: 1,
  }));
  const state = { zip, run, artifact, jobs, downloadToken: false };
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path.includes('signed.example.invalid')) {
      state.downloadToken = Boolean(
        options?.headers && JSON.stringify(options.headers).includes('Bearer'),
      );
      return new Response(new Uint8Array(state.zip));
    }
    if (path.endsWith('/zip'))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://signed.example.invalid/artifact' },
      });
    const data = path.includes('/artifacts?')
      ? { total_count: 1, artifacts: [state.artifact] }
      : path.includes('/jobs?')
        ? { total_count: state.jobs.length, jobs: state.jobs }
        : state.run;
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  return { identity, state, fetch };
}
