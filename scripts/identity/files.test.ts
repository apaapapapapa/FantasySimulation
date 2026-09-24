import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { createTestProject } from '../quality/test-support/project.ts';
import { sourceText } from './files.ts';

it('checks opened source boundaries, exact size, invalid UTF-8 and linked parent paths', () => {
  const f = createTestProject({ 'source.ts': 'export const value = 1;\r\n' });
  try {
    expect(sourceText(f.root, 'source.ts')).toBe('export const value = 1;\n');
    const file = join(f.root, 'source.ts');
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 97));
    expect(sourceText(f.root, 'source.ts')).toHaveLength(2 * 1024 * 1024);
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => sourceText(f.root, 'source.ts')).toThrow(/oversized/);
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => sourceText(f.root, 'source.ts')).toThrow(TypeError);
    mkdirSync(join(f.root, 'actual'));
    writeFileSync(join(f.root, 'actual', 'source.ts'), 'export {};');
    symlinkSync(
      join(f.root, 'actual'),
      join(f.root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => sourceText(f.root, 'alias/source.ts')).toThrow(/Unsafe identity input/);
  } finally {
    f.dispose();
  }
});
