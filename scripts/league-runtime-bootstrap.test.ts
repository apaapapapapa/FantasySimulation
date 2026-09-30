import { afterEach, expect, it, vi } from 'vite-plus/test';
import { lstat, mkdir, readFile, readdir, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { runtimeFixture } from './test-support/league-runtime.ts';
import { artifactZipEntries } from './test-support/league-zip.ts';
import { archiveHash } from './league-archive.ts';
import { bootstrapLeagueRuntime } from './league-runtime-bootstrap.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const runId = 789,
  artifactId = 321;

/** Serve the fixture distribution as the same-SHA main CI artifact, as GitHub would. */
async function serveDistribution(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  const zip = artifactZipEntries(
    await Promise.all(
      ['runtime.gz', 'runtime.json'].map(async (name) => ({
        name,
        payload: await readFile(join(fixture.distribution, name)),
      })),
    ),
  );
  // The bootstrap only requests string URLs.
  const fetch = vi.fn<(path: string) => Promise<Response>>(async (path) => {
    if (path.startsWith('https://signed.example.invalid/'))
      return new Response(new Uint8Array(zip));
    if (path.endsWith(`/actions/artifacts/${artifactId}/zip`))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://signed.example.invalid/runtime' },
      });
    if (path.includes(`/actions/runs/${runId}/artifacts?`))
      return Response.json({
        total_count: 1,
        artifacts: [
          {
            id: artifactId,
            name: `league-runtime-${fixture.sha}`,
            digest: archiveHash(zip),
            size_in_bytes: zip.length,
            expired: false,
            workflow_run: { id: runId, head_sha: fixture.sha },
          },
        ],
      });
    if (path.endsWith(`/actions/runs/${runId}`))
      return Response.json({
        head_sha: fixture.sha,
        path: '.github/workflows/ci.yml',
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        head_repository: { full_name: 'apaapapapapa/FantasySimulation' },
      });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
}

it('installs the same-SHA distribution into a fresh checkout that has no .generated', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root);
    await serveDistribution(fixture);
    await expect(lstat(join(fixture.target, '.generated'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token'),
    ).resolves.toMatchObject({ installed: true, artifactId, sourceSha: fixture.sha });
    expect((await readdir(join(fixture.target, '.generated/runtime-distribution'))).sort()).toEqual(
      ['runtime.gz', 'runtime.json'],
    );
    expect(await readlink(join(fixture.target, 'node_modules/@fantasy/api'))).toBe(
      '../../apps/api',
    );
  });
});

it('refuses to extract the distribution through a symlinked .generated', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root),
      outside = join(root, 'outside');
    await serveDistribution(fixture);
    await mkdir(outside);
    await symlink(outside, join(fixture.target, '.generated'));
    await expect(
      bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token'),
    ).rejects.toThrow('real directory');
    expect(await readdir(outside)).toEqual([]);
    await expect(lstat(join(fixture.target, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
