import { execFileSync } from 'node:child_process';

export function firstPartyJavaScript(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      /\.(?:js|mjs|cjs|jsx)$/.test(path) &&
      !/(?:^|\/)(?:node_modules|\.generated|dist)\//.test(path),
  );
}

export function unsupportedTypeScriptModules(paths: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      /\.(?:mts|cts)$/.test(path) && !/(?:^|\/)(?:node_modules|\.generated|dist)\//.test(path),
  );
}

/** Include new local source before staging; ignored build/dependency output stays out. */
export function qualityPaths(root: string): string[] {
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
    .split('\0')
    .filter(Boolean);
  if (!paths.length) throw Error('Quality source coverage is empty');
  return [...new Set(paths)].sort();
}
export function firstPartyTypeScript(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => /\.tsx?$/.test(path) && !/(?:^|\/)(?:node_modules|\.generated|dist)\//.test(path),
  );
}
