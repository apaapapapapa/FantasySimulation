import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Wording check, not a renderer: local inline links, not remote URLs or anchors.
export function missingLocalLinks(root: string, paths: readonly string[]): string[] {
  const failures: string[] = [];
  for (const path of paths) {
    const file = resolve(root, path);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8').replace(/```[^]*?```/g, '');
    for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1]!;
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)) continue;
      const target = decodeURIComponent(link.split(/[?#]/)[0] ?? '');
      if (!target) continue;
      const absolute = resolve(dirname(file), target),
        inside = relative(root, absolute);
      if (inside.startsWith('..') || !existsSync(absolute)) failures.push(`${path}: ${target}`);
    }
  }
  return failures;
}
