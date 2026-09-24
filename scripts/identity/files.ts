import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { record } from '../harness/report.ts';

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
  const file = resolve(root, path),
    stat = lstatSync(file);
  if (
    contained(root, file) !== path ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 2 * 1024 * 1024
  )
    throw Error(`Unsafe identity input: ${path}`);
  return new TextDecoder('utf-8', { fatal: true })
    .decode(readFileSync(file))
    .replaceAll('\r\n', '\n');
}
