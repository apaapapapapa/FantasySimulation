import { MAX_RECORD_BYTES } from '@fantasy/domain/spatial';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, open, stat, link, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ArtifactRefSchema, type ReplayManifest } from '@fantasy/domain/spatial';

export const sha256 = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const GENERATED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function writeDurableFile(path: string, bytes: string | Uint8Array) {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Atomic, create-only file publication; a stopped writer never exposes a partial pointer/index. */
export async function publishImmutableFile(path: string, bytes: string | Uint8Array) {
  const temporary = join(dirname(path), `.immutable-staging-${randomUUID()}`);
  try {
    await writeDurableFile(temporary, bytes);
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}
export const replayDirectory = (root: string, id: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) throw new Error('Invalid replay ID');
  return join(root, id);
};
/** POSIX publication durability includes directory entries, not just file contents. */
export async function syncDirectory(path: string) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    // Node/libuv on Windows may not expose directory FlushFileBuffers. File sync,
    // atomic rename and mandatory read-time verification still apply; see ADR 0006.
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(code ?? '')
    )
      throw error;
  } finally {
    await handle?.close();
  }
}
/** Bound the actual read, including concurrent growth; never follow artifact symlinks. */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    // Inspect the entry after opening, then read only through that same handle.
    // This also covers platforms without O_NOFOLLOW: a substituted symlink/entry
    // cannot redirect the already-open handle or pass the identity comparison.
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || entry.dev !== info.dev || entry.ino !== info.ino)
      throw new Error('Artifact entry changed or is a symlink');
    if (!info.isFile() || info.size > limit) throw new Error('Artifact size/type limit');
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) throw new Error('Artifact changed while reading');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}
type ArtifactRef = ReplayManifest['chunks'][number] | ReplayManifest['checkpoints'][number];
const decodeGzip = promisify(gunzip);
export async function readCompressed(directory: string, input: ArtifactRef) {
  const ref = ArtifactRefSchema.parse({
    file: input.file,
    bytes: input.bytes,
    rawBytes: input.rawBytes,
    checksum: input.checksum,
  });
  const bytes = await readBoundedFile(join(directory, ref.file), ref.bytes);
  if (bytes.length !== ref.bytes || sha256(bytes) !== ref.checksum)
    throw new Error('Artifact checksum/size mismatch');
  const raw = await decodeGzip(bytes, { maxOutputLength: ref.rawBytes });
  if (raw.length !== ref.rawBytes) throw new Error('Expanded artifact size mismatch');
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
export async function writeCompressed(directory: string, file: string, raw: string) {
  const rawBytes = Buffer.byteLength(raw);
  if (rawBytes > MAX_RECORD_BYTES) throw new Error('Record/checkpoint byte limit');
  const path = join(directory, file);
  await pipeline(
    Readable.from([raw]),
    createGzip({ level: 6 }),
    createWriteStream(path, { flags: 'wx' }),
  );
  // FlushFileBuffers requires write access on Windows; reopening must not truncate.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const bytes = (await stat(path)).size;
  const stored = await readBoundedFile(path, 16 * 1024 * 1024);
  return { file, bytes, rawBytes, checksum: sha256(stored) };
}
