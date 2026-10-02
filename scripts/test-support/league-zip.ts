// Test-only fixed SDK internals: explicit filesystem imports remain visible to architecture checks.
import { getUploadZipSpecification } from '../../node_modules/@actions/artifact/lib/internal/upload/upload-zip-specification.js';
import { createZipUploadStream } from '../../node_modules/@actions/artifact/lib/internal/upload/zip.js';
import { crc32 } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LEAGUE_ARCHIVE_BYTES } from '../league-archive.ts';

/** Actual pinned SDK ZIP encoding; callers mock only the external artifact service. */
export async function realArtifactZip(files: string[], root: string, compressionLevel = 0) {
  const sdk = import.meta.resolve('@actions/artifact');
  const metadata = JSON.parse(await readFile(new URL('../package.json', sdk), 'utf8')) as {
    version: string;
  };
  if (metadata.version !== '6.2.1') throw new Error('Fixture requires pinned artifact SDK 6.2.1');
  const directory = await mkdtemp(join(tmpdir(), 'fantasy-sdk-zip-'));
  try {
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > LEAGUE_ARCHIVE_BYTES ? new Error('SDK ZIP fixture stream bound') : null,
          chunk,
        );
      },
    });
    const path = join(directory, 'artifact.zip');
    await pipeline(
      await createZipUploadStream(getUploadZipSpecification(files, root), compressionLevel),
      bounded,
      createWriteStream(path, { flags: 'wx' }),
    );
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function artifactZip(name: string, payload: Buffer, mode = 0o100644) {
  return artifactZipEntries([{ name, payload, mode }]);
}

/** Stored entries in order, each with its local header offset in the central directory. */
export function artifactZipEntries(entries: { name: string; payload: Buffer; mode?: number }[]) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, payload, mode = 0o100644 } of entries) {
    const filename = Buffer.from(name),
      local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(payload), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(payload), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
