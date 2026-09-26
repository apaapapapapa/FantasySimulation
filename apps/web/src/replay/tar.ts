import { ReplayLoadError } from './artifacts.ts';

/**
 * Minimal uncompressed ustar container for exporting one saved replay as a single file.
 * The entries are the unchanged replay bytes; it adds no format of its own to trust.
 */
export interface TarEntry {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
const BLOCK = 512;
const ascii = new TextEncoder();
const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;
export const tarBytes = (entries: readonly { name: string; bytes: number }[]) =>
  entries.reduce((sum, entry) => sum + BLOCK + padded(entry.bytes), 0) + 2 * BLOCK;

function field(header: Uint8Array, offset: number, length: number, value: string) {
  const bytes = ascii.encode(value);
  if (bytes.length > length) throw new RangeError(`Tar field is too long: ${value}`);
  header.set(bytes, offset);
}
const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';

/** Deterministic regular-file entries: fixed mode/owner and a zero timestamp. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    tarBytes(entries.map((e) => ({ name: e.name, bytes: e.bytes.length }))),
  );
  let offset = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry.name))
      throw new RangeError(`Unsupported tar entry name: ${entry.name}`);
    const header = out.subarray(offset, offset + BLOCK);
    field(header, 0, 100, entry.name);
    field(header, 100, 8, octal(0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(entry.bytes.length, 12));
    field(header, 136, 12, octal(0, 12));
    field(header, 148, 8, '        ');
    field(header, 156, 1, '0');
    field(header, 257, 8, 'ustar\u000000');
    const sum = header.reduce((total, byte) => total + byte, 0);
    field(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    out.set(entry.bytes, offset + BLOCK);
    offset += BLOCK + padded(entry.bytes.length);
  }
  return out;
}

const text = (block: Uint8Array, offset: number, length: number) => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return new TextDecoder('ascii').decode(end < 0 ? raw : raw.subarray(0, end));
};
function number(block: Uint8Array, offset: number, length: number, label: string) {
  const value = text(block, offset, length).trim();
  if (!/^[0-7]{1,11}$/.test(value)) throw new ReplayLoadError('damaged', `Invalid tar ${label}`);
  return parseInt(value, 8);
}

/**
 * Read regular files of a ustar/GNU tar. Directory entries are skipped; links, extended
 * headers and any other entry kind are rejected rather than interpreted.
 */
export function readTar(bytes: Uint8Array<ArrayBuffer>, maxEntries: number): TarEntry[] {
  const entries: TarEntry[] = [];
  for (let offset = 0; ;) {
    if (offset + BLOCK > bytes.length)
      throw new ReplayLoadError('damaged', 'Tar archive ends without its end marker');
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return entries;
    if (!text(header, 257, 6).startsWith('ustar'))
      throw new ReplayLoadError('damaged', 'Not a ustar archive');
    const stored = number(header, 148, 8, 'checksum');
    let sum = 0;
    for (const [i, byte] of header.entries()) sum += i >= 148 && i < 156 ? 32 : byte;
    if (sum !== stored) throw new ReplayLoadError('damaged', 'Tar header checksum mismatch');
    const size = number(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156]!);
    const prefix = text(header, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + text(header, 0, 100);
    const start = offset + BLOCK;
    if (start + size > bytes.length)
      throw new ReplayLoadError('damaged', `Tar entry exceeds the archive: ${name}`);
    offset = start + padded(size);
    if (type === '5') continue;
    if (type !== '0' && type !== '\0')
      throw new ReplayLoadError('damaged', `Unsupported tar entry type for ${name}`);
    if (entries.length >= maxEntries)
      throw new ReplayLoadError('damaged', 'Tar archive has too many files');
    entries.push({ name, bytes: bytes.slice(start, start + size) });
  }
}
