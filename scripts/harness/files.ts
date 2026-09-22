import { openSync, closeSync, fstatSync, readSync } from 'node:fs';

/** Open once: metadata and bounded reads refer to the same descriptor, not a re-resolved path. */
export function readBoundedBytes(path: string, maxBytes = 8 * 1024 * 1024): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024)
    throw new Error('Invalid input budget');
  const descriptor = openSync(path, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid or oversized input');
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > maxBytes) throw new Error('Input exceeds size budget');
    return bytes.subarray(0, size);
  } finally {
    closeSync(descriptor);
  }
}
export function readBoundedJson(path: string, maxBytes = 8 * 1024 * 1024): unknown {
  return JSON.parse(readBoundedBytes(path, maxBytes).toString('utf8')) as unknown;
}
