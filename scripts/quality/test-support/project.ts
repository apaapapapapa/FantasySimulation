import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function createTestProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-quality-'));
  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        target: 'ESNext',
        moduleResolution: 'Bundler',
        noEmit: true,
        jsx: 'preserve',
      },
      include: ['**/*.ts', '**/*.tsx'],
    }),
    ...files,
  };
  const dispose = () => rmSync(root, { recursive: true, force: true });
  try {
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return { root, paths: Object.keys(all), dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
