import { afterEach, expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PathLike } from 'node:fs';
import { runtimeFixture } from './test-support/league-runtime.ts';
import { installLeagueRuntime } from './league-runtime.ts';

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
