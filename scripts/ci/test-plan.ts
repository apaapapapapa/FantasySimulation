import { globSync } from 'node:fs';

export const TEST_INCLUDE = [
  'packages/**/*.test.ts',
  'apps/api/**/*.test.ts',
  'apps/web/**/*.test.ts',
  'scripts/**/*.test.ts',
];
export const TEST_EXCLUDE = ['**/node_modules/**', '**/.git/**', 'scripts/security/**/*.test.ts'];
export function testFiles(root: string): string[] {
  return globSync(TEST_INCLUDE, { cwd: root, exclude: TEST_EXCLUDE })
    .map((path) => path.replaceAll('\\', '/'))
    .sort();
}
