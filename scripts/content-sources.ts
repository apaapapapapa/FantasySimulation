import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_AUTHORING_LIMIT } from '@fantasy/samples/authoring';

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
    const data = readFileSync(path);
    if (data.length !== stat.size) throw new Error('Content source changed during read');
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
