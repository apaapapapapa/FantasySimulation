import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { record } from '../harness/report.ts';
import { readBoundedBytes } from '../harness/files.ts';

export const hash = (value: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const json = (file: string) => record(JSON.parse(readFileSync(file, 'utf8')) as unknown);
export function contained(root: string, file: string): string {
  const path = relative(realpathSync(root), realpathSync(file));
  if (!path || path === '..' || path.startsWith(`..${sep}`))
    throw Error(`Identity input escapes repository: ${file}`);
  return path.split(sep).join('/');
}
export function sourceText(root: string, path: string): string {
  const file = resolve(root, path);
  const bytes = readBoundedBytes(file, 2 * 1024 * 1024, (opened) => {
    // Validate after open, then read only that descriptor. A substituted path
    // cannot redirect the read between the metadata check and the byte bound.
    const entry = lstatSync(file);
    if (
      contained(root, file) !== path ||
      entry.isSymbolicLink() ||
      entry.dev !== opened.dev ||
      entry.ino !== opened.ino
    )
      throw Error(`Unsafe identity input: ${path}`);
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
}
