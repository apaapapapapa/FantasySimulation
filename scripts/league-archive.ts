import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

export const LEAGUE_ARCHIVE_BYTES = 64 * 1024 ** 2;
export const archiveHash = (bytes: Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Validate the central AND local directory before extracting a bounded, authenticated ZIP. */
export async function extractLeagueArchive(
  data: Buffer,
  destination: string,
  allow: (key: string) => boolean,
  allowDirectories = true,
  profile?: 'store-files-v1',
) {
  if (data.length < 22 || data.length > LEAGUE_ARCHIVE_BYTES)
    throw new Error('Artifact archive size bound');
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < 0 ||
    data.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + data.readUInt16LE(end + 20) !== data.length ||
    data.readUInt16LE(end + 4) !== 0 ||
    data.readUInt16LE(end + 6) !== 0 ||
    data.readUInt16LE(end + 8) !== data.readUInt16LE(end + 10)
  )
    throw new Error('Invalid artifact ZIP directory');
  const count = data.readUInt16LE(end + 10),
    central = data.readUInt32LE(end + 16);
  if (profile && (end !== data.length - 22 || count > 4096))
    throw new Error('STORE archive trailer/count bound');
  if (count < 1 || count > 50000 || central + data.readUInt32LE(end + 12) !== end)
    throw new Error('Artifact ZIP64/entry/directory bound');
  const entries: {
    name: string;
    directory: boolean;
    start: number;
    offset: number;
    compressed: number;
    size: number;
    method: number;
    crc: number;
  }[] = [];
  const names = new Set<string>();
  let position = central,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const flags = data.readUInt16LE(position + 8),
      method = data.readUInt16LE(position + 10);
    const nameLength = data.readUInt16LE(position + 28),
      extra = data.readUInt16LE(position + 30),
      comment = data.readUInt16LE(position + 32);
    if (
      profile &&
      (method !== 0 || extra !== 0 || comment !== 0 || nameLength > 256 || flags & ~0x808)
    )
      throw new Error('STORE archive format/name bound');
    if (position + 46 + nameLength + extra + comment > end) throw new Error('Truncated ZIP entry');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      data.subarray(position + 46, position + 46 + nameLength),
    );
    const directory = name.endsWith('/'),
      key = directory ? name.slice(0, -1) : name;
    const mode = data.readUInt32LE(position + 38) >>> 16,
      kind = mode & 0xf000;
    if (
      names.has(key) ||
      (directory && !allowDirectories) ||
      !key ||
      key.includes('\\') ||
      key.split('/').some((part) => !part || part === '.' || part === '..') ||
      !/^[A-Za-z0-9_.@/-]+$/.test(key) ||
      (!directory && !allow(key)) ||
      ![0, directory ? 0x4000 : 0x8000].includes(kind) ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      throw new Error('Unsafe artifact path/type/method');
    names.add(key);
    const size = data.readUInt32LE(position + 24),
      compressed = data.readUInt32LE(position + 20),
      start = data.readUInt32LE(position + 42);
    expanded += size;
    if (
      expanded > LEAGUE_ARCHIVE_BYTES ||
      start + 30 > central ||
      data.readUInt32LE(start) !== 0x04034b50
    )
      throw new Error('Artifact expansion/local-header bound');
    const localName = data.readUInt16LE(start + 26),
      localExtra = data.readUInt16LE(start + 28),
      offset = start + 30 + localName + localExtra;
    if (profile) {
      if (directory || localExtra !== 0 || compressed !== size)
        throw new Error('STORE archive local format');
      const crc = data.readUInt32LE(position + 16);
      if (flags & 8) {
        const descriptor = offset + compressed;
        if (
          descriptor + 16 > central ||
          data.readUInt32LE(descriptor) !== 0x08074b50 ||
          data.readUInt32LE(descriptor + 4) !== crc ||
          data.readUInt32LE(descriptor + 8) !== compressed ||
          data.readUInt32LE(descriptor + 12) !== size ||
          data.readUInt32LE(start + 14) !== 0 ||
          data.readUInt32LE(start + 18) !== 0 ||
          data.readUInt32LE(start + 22) !== 0
        )
          throw new Error('STORE archive descriptor mismatch');
      } else if (
        data.readUInt32LE(start + 14) !== crc ||
        data.readUInt32LE(start + 18) !== compressed ||
        data.readUInt32LE(start + 22) !== size
      )
        throw new Error('STORE archive local size/CRC mismatch');
    }
    if (
      localName !== nameLength ||
      !data
        .subarray(start + 30, start + 30 + localName)
        .equals(data.subarray(position + 46, position + 46 + nameLength)) ||
      data.readUInt16LE(start + 6) !== flags ||
      data.readUInt16LE(start + 8) !== method ||
      offset + compressed > central ||
      (directory && (size !== 0 || compressed > 2))
    )
      throw new Error('Artifact local directory mismatch');
    entries.push({
      name: key,
      directory,
      start,
      offset,
      compressed,
      size,
      method,
      crc: data.readUInt32LE(position + 16),
    });
    position += 46 + nameLength + extra + comment;
  }
  if (position !== end) throw new Error('Artifact directory length mismatch');
  const ordered = [...entries].sort((a, b) => a.start - b.start);
  if (profile) {
    let next = 0;
    for (const entry of ordered) {
      if (entry.start !== next) throw new Error('STORE archive hidden bytes');
      next = entry.offset + entry.compressed + (data.readUInt16LE(entry.start + 6) & 8 ? 16 : 0);
    }
    if (next !== central) throw new Error('STORE archive hidden trailer bytes');
  }
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i]!.start < ordered[i - 1]!.offset + ordered[i - 1]!.compressed)
      throw new Error('Overlapping artifact ZIP entries');
  const files = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name));
  for (const entry of entries)
    for (let parent = dirname(entry.name); parent !== '.'; parent = dirname(parent))
      if (files.has(parent)) throw new Error('Artifact file used as directory');
  await mkdir(destination); // Caller supplies a fresh owned directory; never follow existing paths.
  for (const entry of entries) {
    if (entry.directory) continue;
    const compressed = data.subarray(entry.offset, entry.offset + entry.compressed);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: LEAGUE_ARCHIVE_BYTES });
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc)
      throw new Error('Artifact CRC/expanded-size mismatch');
    const path = join(destination, entry.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }
  return { files: files.size, bytes: expanded };
}

export async function boundedArtifactResponse(response: Response) {
  if (!response.ok || !response.body) throw new Error('Artifact download failed');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > LEAGUE_ARCHIVE_BYTES) throw new Error('Artifact streamed ZIP bound');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, bytes);
}
