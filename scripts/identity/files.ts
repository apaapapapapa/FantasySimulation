import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
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
  const rootPath = realpathSync(root),
    file = resolve(rootPath, path);
  const bytes = readBoundedBytes(file, 2 * 1024 * 1024, (_opened, descriptor) =>
    assertSourceDescriptor(rootPath, path, descriptor),
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
}
/** Compare the kernel descriptor target to the canonical root captured before opening. */
export function assertSourceDescriptor(root: string, path: string, descriptor: number): void {
  if (process.platform !== 'linux')
    throw Error('Execution identity capture requires Linux /proc/self/fd');
  const openedPath = readlinkSync(`/proc/self/fd/${descriptor}`),
    relativePath = relative(root, openedPath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.split(sep).join('/') !== path
  )
    throw Error(`Unsafe identity input: ${path}`);
}
