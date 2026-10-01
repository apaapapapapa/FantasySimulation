import { expect, it } from 'vite-plus/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { artifactZip, artifactZipEntries } from './test-support/league-zip.ts';
import { extractLeagueArchive, LEAGUE_ARCHIVE_BYTES } from './league-archive.ts';

it('extracts exact allowlisted bytes and rejects CRC changes, links and traversal before publication', async () => {
  await withReplayDirectory(async (root) => {
    const bytes = Buffer.from('{"version":1}');
    const archive = artifactZip('proof.json', bytes);
    await extractLeagueArchive(archive, join(root, 'valid'), (key) => key === 'proof.json');
    expect(await readFile(join(root, 'valid/proof.json'))).toEqual(bytes);
    for (const [name, mode] of [
      ['../escape', 0o100644],
      ['/absolute', 0o100644],
      ['proof.json', 0o120777],
    ] as const)
      await expect(
        extractLeagueArchive(artifactZip(name, bytes, mode), join(root, 'unsafe'), () => true),
      ).rejects.toThrow('Unsafe');
    const corrupt = Buffer.from(archive);
    corrupt[40] = corrupt[40]! ^ 1;
    await expect(extractLeagueArchive(corrupt, join(root, 'corrupt'), () => true)).rejects.toThrow(
      'CRC',
    );
    const bomb = Buffer.from(archive);
    bomb.writeUInt32LE(LEAGUE_ARCHIVE_BYTES + 1, 30 + 'proof.json'.length + bytes.length + 24);
    await expect(extractLeagueArchive(bomb, join(root, 'bomb'), () => true)).rejects.toThrow(
      'bound',
    );
  });
});

it('keeps legacy directory entries while packed archives require exact file entries', async () => {
  await withReplayDirectory(async (root) => {
    const bytes = Buffer.from('{}');
    const file = { name: 'partitions/0/proof.json', payload: bytes };
    const archive = artifactZipEntries([
      { name: 'partitions/', payload: Buffer.alloc(0), mode: 0o40755 },
      file,
    ]);
    await extractLeagueArchive(archive, join(root, 'legacy'), () => true);
    expect(await readFile(join(root, 'legacy', file.name))).toEqual(bytes);
    await expect(
      extractLeagueArchive(archive, join(root, 'packed-invalid'), () => true, false),
    ).rejects.toThrow('Unsafe');
    await extractLeagueArchive(
      artifactZipEntries([file]),
      join(root, 'packed-valid'),
      () => true,
      false,
    );
    expect(await readFile(join(root, 'packed-valid', file.name))).toEqual(bytes);
  });
});
