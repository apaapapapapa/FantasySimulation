import { expect, it } from 'vite-plus/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { withReplayDirectory } from '../test-support/replays.ts';
import {
  assertPublicData,
  inspectPublicArtifact,
  publicationJson,
  writePublication,
} from './publication-files.ts';
import { sha256 } from './replay-files.ts';

it.each([
  '/home/person/database.sqlite',
  'C:\\Users\\person\\secret',
  '\\\\server\\share',
  '.work/local.sqlite',
  'load /tmp/private',
  'password=fixture-only',
  'https://user:pass@example.test/data',
  { environment: { value: 'private' } },
  { credentials: 'fixture' },
])('rejects private data without echoing its value', (value) => {
  expect(() => assertPublicData({ name: value })).toThrow('Private');
});
it('scans expanded compressed artifacts before including their original bytes', async () => {
  const raw = JSON.stringify({ reason: 'load /home/private/keys' }) + '\n',
    data = gzipSync(raw);
  await expect(
    inspectPublicArtifact(
      {
        key: `objects/${'a'.repeat(64)}/chunk-00000.ndjson.gz`,
        bytes: data.length,
        checksum: sha256(data),
        data,
      },
      Buffer.byteLength(raw),
    ),
  ).rejects.toThrow(/Private/);
});
it('leaves current unchanged on an interrupted copy and resumes existing immutable files', async () => {
  await withReplayDirectory(async (root) => {
    const target = join(root, 'public');
    await mkdir(join(target, '.publication-lock'), { recursive: true });
    const first = publicationJson(`catalog/${'a'.repeat(64)}.json`, { fixture: 'first' });
    const current = publicationJson('catalog/current.json', { fixture: 'pointer' });
    const missing = {
      key: `catalog/${'b'.repeat(64)}.json`,
      source: join(root, 'delayed.json'),
      bytes: 2,
      checksum: sha256('{}'),
    };
    await expect(
      writePublication(target, [first, missing], current, null, 1_000_000),
    ).rejects.toThrow();
    await expect(readFile(join(target, current.key))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(missing.source, '{}');
    expect(
      await writePublication(target, [first, missing], current, null, 1_000_000),
    ).toMatchObject({ addedFiles: 1, reusedFiles: 1 });
    expect(await readFile(join(target, current.key))).toEqual(current.data);
  });
});
it('refuses a stale expected generation before writing files', async () => {
  await withReplayDirectory(async (root) => {
    await mkdir(join(root, 'catalog'));
    const current = publicationJson('catalog/current.json', { fixture: 'new' });
    await writeFile(join(root, current.key), '{"fixture":"other"}');
    await expect(
      writePublication(
        root,
        [publicationJson(`catalog/${'a'.repeat(64)}.json`, {})],
        current,
        null,
        1_000_000,
      ),
    ).rejects.toThrow(/generation changed/);
    expect(await readdir(join(root, 'catalog'))).toEqual(['current.json']);
  });
});
