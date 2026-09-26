import { lstatSync, readdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_AUTHORING_LIMIT } from '@fantasy/samples/authoring';
import { readBoundedBytes } from './harness/files.ts';

/** Validate and read the same opened file, even if its path changes after discovery. */
export function readContentFile(path: string, expected: Stats): Buffer {
  const data = readBoundedBytes(path, 4_000_000, (opened) => {
    const entry = lstatSync(path);
    if (
      entry.isSymbolicLink() ||
      entry.dev !== opened.dev ||
      entry.ino !== opened.ino ||
      expected.dev !== opened.dev ||
      expected.ino !== opened.ino ||
      expected.size !== opened.size ||
      expected.mtimeMs !== opened.mtimeMs
    )
      throw new Error('Content source changed before read');
  });
  if (data.length !== expected.size) throw new Error('Content source changed during read');
  return data;
}

/** Filesystem discovery is tooling-only; the compiler itself has no platform I/O. */
export function readContentSources(root: string) {
  const files: string[] = [];
  const inputs: unknown[] = [];
  let bytes = 0;
  function visit(path: string, depth: number) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || depth > 8) throw new Error('Unsafe content source path');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
      return;
    }
    if (!path.endsWith('.json')) return;
    if (!stat.isFile() || stat.size > 4_000_000 || files.length >= 256)
      throw new Error('Content source file limit exceeded');
    bytes += stat.size;
    if (bytes > 16_000_000) throw new Error('Content source byte limit exceeded');
    const data = readContentFile(path, stat);
    const value: unknown = JSON.parse(data.toString('utf8'));
    const entries: unknown[] = Array.isArray(value) ? value : [value];
    if (inputs.length + entries.length > CATALOG_AUTHORING_LIMIT)
      throw new Error('Content source revision limit exceeded');
    files.push(path);
    inputs.push(...entries);
  }
  visit(root, 0);
  if (!files.length) throw new Error('No authored content files');
  return { files, inputs, bytes };
}
