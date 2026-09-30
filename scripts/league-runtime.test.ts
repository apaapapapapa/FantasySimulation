import { expect, it } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { readFile, writeFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runtimeFixture } from './test-support/league-runtime.ts';
import { installLeagueRuntime } from './league-runtime.ts';

it('installs the hashed native dependency closure and root loader in a separate checkout', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root);
    const manifest = JSON.parse(await readFile(join(fixture.distribution, 'runtime.json'), 'utf8'));
    // The SDK fixture declares its build-only generator, intentionally absent from
    // the checkout. Installing/importing the SDK must need only its generated RPC.
    expect(
      manifest.files.some((entry: { path: string }) => entry.path.includes('@protobuf-ts+plugin')),
    ).toBe(false);
    await installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha);
    expect(await readlink(join(fixture.target, 'node_modules/@fantasy/api'))).toBe(
      '../../apps/api',
    );
    expect(
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          'import {fixture} from "@actions/artifact"; console.log(fixture);',
        ],
        { cwd: fixture.target, encoding: 'utf8' },
      ).trim(),
    ).toBe('true');
    await expect(
      installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
    ).rejects.toThrow('empty dependencies');
  });
});
it.each(['sourceSha', 'node', 'platform', 'arch', 'lockHash', 'archiveHash'] as const)(
  'rejects changed %s before installing dependencies',
  async (key) => {
    await withReplayDirectory(async (root) => {
      const fixture = await runtimeFixture(root),
        path = join(fixture.distribution, 'runtime.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest[key] = key.endsWith('Hash')
        ? 'sha256:' + '0'.repeat(64)
        : key === 'sourceSha'
          ? '0'.repeat(40)
          : 'forged';
      await writeFile(path, JSON.stringify(manifest));
      await expect(
        installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
      ).rejects.toThrow();
    });
  },
);
it('requires the declared generator dependency again when the artifact SDK version changes', async () => {
  await withReplayDirectory(async (root) => {
    await expect(runtimeFixture(root, '6.2.2')).rejects.toThrow(
      'Missing runtime dependency: @protobuf-ts/plugin',
    );
  });
});
it('rejects an altered native file digest and a path traversing out of the checkout', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root),
      path = join(fixture.distribution, 'runtime.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const file = manifest.files.find((entry: { path: string }) =>
      entry.path.endsWith('native.node'),
    );
    const original = file.hash;
    file.hash = 'sha256:' + '0'.repeat(64);
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
    ).rejects.toThrow('digest');
    file.hash = original;
    file.path = 'node_modules/../../escape';
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
    ).rejects.toThrow('path');
  });
});
