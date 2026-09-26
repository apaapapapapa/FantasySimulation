import { afterEach, expect, it, vi } from 'vite-plus/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '../test-support/replays.ts';
import { measuredCommand } from './measurement-report.ts';
import { measureAsync } from './measurements.ts';
afterEach(() => vi.unstubAllEnvs());
it('is opt-in and preserves the original failure while keeping failed diagnostic evidence', async () => {
  await withReplayDirectory(async (root) => {
    vi.stubEnv('FANTASY_MEASUREMENTS_DIR', '');
    expect(await measuredCommand('disabled', async () => 17)).toBe(17);
    expect(await readdir(root)).toEqual([]);
    vi.stubEnv('FANTASY_MEASUREMENTS_DIR', root);
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'PRIVATE_MEASUREMENT_SENTINEL');
    const error = new Error('PRIVATE_MEASUREMENT_SENTINEL');
    await expect(
      measuredCommand('fixture', () =>
        measureAsync('read', async () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    const raw = await readFile(join(root, files[0]!), 'utf8');
    expect(raw).not.toContain('PRIVATE_MEASUREMENT_SENTINEL');
    expect(JSON.parse(raw)).toMatchObject({
      status: 'failed',
      stages: { read: { count: 1, failures: 1 } },
    });
    const notDirectory = join(root, 'file');
    await writeFile(notDirectory, 'occupied');
    vi.stubEnv('FANTASY_MEASUREMENTS_DIR', notDirectory);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await measuredCommand('unwritable', async () => 42)).toBe(42);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
