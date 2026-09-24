import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { createTestProject } from '../quality/test-support/project.ts';
import { assertSourceDescriptor, sourceText } from './files.ts';

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

it('rejects an outside descriptor even after its parent path is replaced by an in-root directory', () => {
  const inside = createTestProject({ 'parent/source.ts': 'inside' });
  const outside = createTestProject({ 'source.ts': 'outside' });
  const parent = join(inside.root, 'parent'),
    saved = join(inside.root, 'saved');
  let descriptor: number | undefined;
  try {
    renameSync(parent, saved);
    symlinkSync(outside.root, parent, 'dir');
    descriptor = openSync(join(parent, 'source.ts'), 'r');
    unlinkSync(parent);
    renameSync(saved, parent);
    expect(() => assertSourceDescriptor(inside.root, 'parent/source.ts', descriptor!)).toThrow(
      'Unsafe identity input',
    );
    expect(sourceText(inside.root, 'parent/source.ts')).toBe('inside');
    closeSync(descriptor);
    const closed = descriptor;
    descriptor = undefined;
    expect(() => assertSourceDescriptor(inside.root, 'parent/source.ts', closed)).toThrow();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    inside.dispose();
    outside.dispose();
  }
});
