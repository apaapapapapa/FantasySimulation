import { lstat, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { publicationDirectory } from './publication-files.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, lstat: vi.fn(fs.lstat), mkdir: vi.fn(fs.mkdir) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'publication-directory-'));
  roots.push(root);
  const objects = join(root, 'objects');
  await mkdir(objects);
  return { root, objects };
}

it('shares concurrent ancestor syscalls but performs fresh checks after completion', async () => {
  const { root, objects } = await directoryFixture();
  await Promise.all(Array.from({ length: 20 }, () => publicationDirectory(objects)));
  const calls = (path: string) => vi.mocked(lstat).mock.calls.filter(([file]) => file === path);
  expect(calls(root)).toHaveLength(1);
  expect(calls(objects)).toHaveLength(1);
  await publicationDirectory(objects);
  expect(calls(root)).toHaveLength(2);
  expect(calls(objects)).toHaveLength(2);
});

it('shares mkdir only for overlapping creates without caching it for later writes', async () => {
  const { objects } = await directoryFixture();
  const child = join(objects, 'new-object');
  await Promise.all(Array.from({ length: 12 }, () => publicationDirectory(child, true)));
  const creations = () => vi.mocked(mkdir).mock.calls.filter(([path]) => path === child);
  expect(creations()).toHaveLength(1);
  await publicationDirectory(child, true);
  expect(creations()).toHaveLength(2);
});

it('rejects an ancestor replaced by a symlink and forgets the failed check after repair', async () => {
  const { root, objects } = await directoryFixture();
  const child = join(objects, 'child');
  await mkdir(child);
  await publicationDirectory(child);
  const moved = join(root, 'original-objects');
  await rename(objects, moved);
  await symlink(moved, objects);
  const rejected = await Promise.allSettled([
    publicationDirectory(child),
    publicationDirectory(child),
  ]);
  expect(rejected.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  await rm(objects);
  await rename(moved, objects);
  await expect(publicationDirectory(child)).resolves.toBeUndefined();
});

it('does not let an overlapping read substitute for a requested directory creation', async () => {
  const { objects } = await directoryFixture();
  vi.mocked(mkdir).mockClear();
  await Promise.all([publicationDirectory(objects), publicationDirectory(objects, true)]);
  expect(vi.mocked(mkdir).mock.calls.filter(([path]) => path === objects)).toHaveLength(1);
});
