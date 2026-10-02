import { afterEach, expect, it, vi } from 'vite-plus/test';
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { runtimeFixture } from './test-support/league-runtime.ts';
import { artifactZipEntries } from './test-support/league-zip.ts';
import { archiveHash } from './league-archive.ts';
import * as archiveModule from './league-archive.ts';
import { bootstrapLeagueRuntime, runtimeBootstrapOptions } from './league-runtime-bootstrap.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['runtime.json', 'runtime.gz'] as const)(
  'rejects %s mutation between authenticated extraction and the first snapshot',
  async (name) => {
    await withReplayDirectory(async (root) => {
      const fixture = await runtimeFixture(root);
      await serveDistribution(fixture);
      const extract = archiveModule.extractLeagueArchive;
      vi.spyOn(archiveModule, 'extractLeagueArchive').mockImplementation(async (...args) => {
        const result = await extract(...args);
        const path = join(args[1], name);
        const original = await readFile(path);
        if (name === 'runtime.json') {
          const manifest = JSON.parse(original.toString('utf8'));
          manifest.files.find((entry: { type: string }) => entry.type === 'file').mode = 493;
          await writeFile(path, JSON.stringify(manifest) + '\n');
        } else {
          const altered = Buffer.from(original);
          altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
          await writeFile(path, altered);
        }
        return result;
      });
      await expect(
        bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token', {
          requireArtifact: true,
        }),
      ).rejects.toThrow('authenticated ZIP payload');
      await expect(lstat(join(fixture.target, 'node_modules'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

const runId = 789,
  artifactId = 321;

/** Serve the fixture distribution as the same-SHA main CI artifact, as GitHub would. */
async function serveDistribution(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  state: 'ready' | 'missing' | 'expired' | 'foreign-source' | 'bad-digest' = 'ready',
) {
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
        total_count: state === 'missing' ? 0 : 1,
        artifacts:
          state === 'missing'
            ? []
            : [
                {
                  id: artifactId,
                  name: `league-runtime-${fixture.sha}`,
                  digest: state === 'bad-digest' ? 'sha256:' + '0'.repeat(64) : archiveHash(zip),
                  size_in_bytes: zip.length,
                  expired: state === 'expired',
                  workflow_run: { id: runId, head_sha: fixture.sha },
                },
              ],
      });
    if (path.endsWith(`/actions/runs/${runId}`))
      return Response.json({
        head_sha: state === 'foreign-source' ? '0'.repeat(40) : fixture.sha,
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
  return zip;
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

it.each(['missing', 'expired'] as const)(
  'keeps default %s fallback but strict mode never writes',
  async (state) => {
    await withReplayDirectory(async (root) => {
      const fixture = await runtimeFixture(root);
      await serveDistribution(fixture, state);
      await expect(
        bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token'),
      ).resolves.toEqual({ installed: false, reason: state });
      await expect(
        bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token', {
          requireArtifact: true,
        }),
      ).rejects.toThrow(`Required runtime distribution ${state}`);
      for (const directory of ['.generated', 'node_modules'])
        await expect(lstat(join(fixture.target, directory))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    });
  },
);

it('returns actual authenticated CI and archive provenance in strict mode', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root);
    const zip = await serveDistribution(fixture);
    const actual = await bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token', {
      requireArtifact: true,
    });
    expect(actual).toMatchObject({
      installed: true,
      provenance: {
        runId,
        sourceSha: fixture.sha,
        artifactId,
        name: `league-runtime-${fixture.sha}`,
        outerZipDigest: archiveHash(zip),
        outerZipBytes: zip.length,
        manifestHash: archiveHash(await readFile(join(fixture.distribution, 'runtime.json'))),
        archiveHash: archiveHash(await readFile(join(fixture.distribution, 'runtime.gz'))),
      },
    });
  });
});

it.each(['foreign-source', 'bad-digest'] as const)(
  'rejects %s without fallback or installation',
  async (state) => {
    await withReplayDirectory(async (root) => {
      const fixture = await runtimeFixture(root);
      await serveDistribution(fixture, state);
      for (const requireArtifact of [false, true])
        await expect(
          bootstrapLeagueRuntime(fixture.target, runId, fixture.sha, 'token', { requireArtifact }),
        ).rejects.toThrow();
      await expect(lstat(join(fixture.target, 'node_modules'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

it.each([
  { args: [], input: 'false', expected: false },
  { args: [], input: 'true', expected: true },
  { args: ['--require-artifact'], input: 'false', expected: true },
  { args: ['--require-artifact'], input: 'true', expected: true },
])('parses runtime CLI strict opt-in $args / $input', ({ args, input, expected }) => {
  expect(runtimeBootstrapOptions(args, input)).toEqual({ requireArtifact: expected });
});

it.each(['', 'TRUE', '1', 'yes', 'false '])('rejects runtime action boolean input %j', (input) => {
  expect(() => runtimeBootstrapOptions([], input)).toThrow('arguments');
});
it.each([
  { args: ['--unknown'] },
  { args: ['--require-artifact=false'] },
  { args: ['--require-artifact', '--require-artifact'] },
])('rejects unknown runtime CLI arguments $args', ({ args }) => {
  expect(() => runtimeBootstrapOptions(args)).toThrow('arguments');
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
