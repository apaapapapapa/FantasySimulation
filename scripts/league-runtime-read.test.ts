import { afterEach, expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { chmod, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { PathLike } from 'node:fs';
import { runtimeFixture } from './test-support/league-runtime.ts';
import { installLeagueRuntime, verifyLeagueRuntime } from './league-runtime.ts';

const race = vi.hoisted(() => ({
  afterInspect: undefined as ((path: PathLike) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const info = await fs.lstat(...args);
      await race.afterInspect?.(args[0]);
      return info;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      await race.afterInspect?.(args[0]);
      return file;
    },
  };
});
afterEach(() => {
  race.afterInspect = undefined;
});

it('keeps the opened inode when the inspected distribution path is replaced by a symlink', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root);
    const path = join(fixture.distribution, 'runtime.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.sourceSha = '0'.repeat(40);
    await writeFile(join(fixture.distribution, 'forged.json'), JSON.stringify(manifest) + '\n');
    let replaced = false;
    race.afterInspect = async (inspected) => {
      if (String(inspected) !== path || replaced) return;
      replaced = true;
      await rename(path, path + '.original');
      await symlink('forged.json', path);
    };
    await expect(
      installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
    ).resolves.toMatchObject({ sourceSha: fixture.sha });
    expect(replaced).toBe(true);
  });
});

it.each(['runtime.json', 'runtime.gz'])(
  'rejects a pre-existing %s symlink before reading',
  async (name) => {
    await withReplayDirectory(async (root) => {
      const fixture = await runtimeFixture(root),
        path = join(fixture.distribution, name);
      await rename(path, path + '.original');
      await symlink(name + '.original', path);
      await expect(
        installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
      ).rejects.toMatchObject({ code: 'ELOOP' });
    });
  },
);

it('verifies the complete installed runtime without claiming authenticated main CI', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root);
    await installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha);
    const actual = await verifyLeagueRuntime(fixture.target, fixture.distribution, fixture.sha);
    expect(actual).toMatchObject({
      sourceSha: fixture.sha,
      scope: 'local-dependency-snapshot',
      authenticatedMainCI: false,
    });
    const manifest = JSON.parse(await readFile(join(fixture.distribution, 'runtime.json'), 'utf8'));
    expect(actual.files).toBe(manifest.files.length);
    expect(actual.bytes).toBe(
      manifest.files.reduce(
        (sum: number, file: { type: string; bytes?: number }) =>
          sum + (file.type === 'file' ? file.bytes! : 0),
        0,
      ),
    );
  });
});

it.each(['content', 'missing', 'link', 'mode', 'extra', 'dirty', 'archive'] as const)(
  'rejects an installed runtime with %s mutation',
  async (mutation) => {
    await withReplayDirectory(async (root) => {
      const fixture = await runtimeFixture(root);
      await installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha);
      const native = join(fixture.target, 'node_modules/@actions/artifact/native.node');
      if (mutation === 'content') await writeFile(native, 'altered native data');
      if (mutation === 'missing') await rm(native);
      if (mutation === 'link') {
        const link = join(fixture.target, 'node_modules/@fantasy/api');
        await rm(link);
        await symlink('../../apps/cli', link);
      }
      if (mutation === 'mode') await chmod(native, 0o600);
      if (mutation === 'extra')
        await writeFile(join(fixture.target, 'node_modules/@actions/artifact/extra.js'), 'unknown');
      if (mutation === 'dirty')
        await writeFile(join(fixture.target, '.node-version'), process.version.slice(1) + '\n');
      if (mutation === 'archive')
        await writeFile(join(fixture.distribution, 'runtime.gz'), 'corrupt');
      await expect(
        verifyLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
      ).rejects.toThrow();
    });
  },
);

it('rejects a subset manifest even with a matching re-encoded archive and hashes', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await runtimeFixture(root);
    await installLeagueRuntime(fixture.target, fixture.distribution, fixture.sha);
    const path = join(fixture.distribution, 'runtime.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const data = gunzipSync(await readFile(join(fixture.distribution, 'runtime.gz')));
    const omitted = manifest.files.findIndex(
      (file: { type: string; path: string }) =>
        file.type === 'file' && file.path.endsWith('native.node'),
    );
    let offset = 0;
    const kept: Buffer[] = [];
    for (const [index, file] of manifest.files.entries())
      if (file.type === 'file') {
        if (index !== omitted) kept.push(data.subarray(offset, offset + file.bytes));
        offset += file.bytes;
      }
    manifest.files.splice(omitted, 1);
    const archive = gzipSync(Buffer.concat(kept));
    manifest.archiveBytes = archive.length;
    manifest.archiveHash = 'sha256:' + createHash('sha256').update(archive).digest('hex');
    await writeFile(join(fixture.distribution, 'runtime.gz'), archive);
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      verifyLeagueRuntime(fixture.target, fixture.distribution, fixture.sha),
    ).rejects.toThrow('complete dependency closure');
  });
});
