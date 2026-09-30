import { appendFile, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveHash, boundedArtifactResponse, extractLeagueArchive } from './league-archive.ts';
import { installLeagueRuntime } from './league-runtime.ts';

/** Bootstrap uses builtins only. Missing/expired distribution is the sole fallback condition. */
export async function bootstrapLeagueRuntime(
  root: string,
  runId: number,
  sha: string,
  token: string,
) {
  if (!Number.isSafeInteger(runId) || runId < 1 || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error('Invalid runtime CI identity');
  const base = 'https://api.github.com/repos/apaapapapapa/FantasySimulation';
  const request = async (path: string) => {
    const response = await fetch(base + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Runtime CI metadata request failed');
    return response.json();
  };
  const run = await request(`/actions/runs/${runId}`);
  if (
    run.head_sha !== sha ||
    run.path !== '.github/workflows/ci.yml' ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_repository?.full_name !== 'apaapapapapa/FantasySimulation'
  )
    throw new Error('Runtime requires successful same-SHA main CI');
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const value = await request(
      `/actions/runs/${runId}/artifacts?name=league-runtime-${sha}&per_page=100&page=${page}`,
    );
    if (value.total_count > 256) throw new Error('Runtime CI artifact count bound');
    all.push(...value.artifacts);
    if (value.total_count > 1) throw new Error('Ambiguous runtime distribution');
    if (value.artifacts.length < 100) break;
    if (page === 3) throw new Error('Runtime CI pagination incomplete');
  }
  const candidates = all.filter((a) => a.name === `league-runtime-${sha}`);
  if (candidates.length > 1) throw new Error('Ambiguous runtime distribution');
  const ref = candidates[0];
  if (!ref || ref.expired) return { installed: false, reason: ref ? 'expired' : 'missing' };
  if (
    !/^sha256:[a-f0-9]{64}$/.test(ref.digest) ||
    ref.workflow_run?.id !== runId ||
    ref.workflow_run?.head_sha !== sha
  )
    throw new Error('Invalid runtime artifact provenance');
  const redirect = await fetch(`${base}/actions/artifacts/${ref.id}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  const location = redirect.headers.get('location');
  if (redirect.status !== 302 || !location || new URL(location).protocol !== 'https:')
    throw new Error('Invalid runtime artifact redirect');
  const bytes = await boundedArtifactResponse(
    await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(120000) }),
  );
  if (bytes.length !== ref.size_in_bytes || archiveHash(bytes) !== ref.digest)
    throw new Error('Runtime actual ZIP digest mismatch');
  // A fresh checkout has no .generated; create it, but never extract through a link.
  const generated = join(root, '.generated');
  await mkdir(generated, { recursive: true });
  if (!(await lstat(generated)).isDirectory())
    throw new Error('Runtime distribution parent must be a real directory');
  const distribution = join(generated, 'runtime-distribution');
  await extractLeagueArchive(bytes, distribution, (key) =>
    ['runtime.gz', 'runtime.json'].includes(key),
  );
  const result = await installLeagueRuntime(root, distribution, sha);
  return { installed: true, artifactId: ref.id, archiveBytes: bytes.length, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const started = performance.now();
  const result = await bootstrapLeagueRuntime(
    process.cwd(),
    Number(process.env.LEAGUE_CI_RUN),
    process.env.GITHUB_SHA ?? '',
    process.env.LEAGUE_ARTIFACT_TOKEN ?? '',
  );
  console.log(JSON.stringify({ runtime: result, elapsedMs: performance.now() - started }));
  await appendFile(process.env.GITHUB_OUTPUT!, `installed=${result.installed}\n`);
}
