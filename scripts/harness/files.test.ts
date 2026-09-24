import { mkdtempSync, writeFileSync, rmSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vite-plus/test';
import { readBoundedJson, readBoundedBytes } from './files.ts';
import { createTestProject } from '../quality/test-support/project.ts';
it('keeps metadata and reads on the opened descriptor when its path is replaced', () => {
  const f = createTestProject({ 'input.txt': 'original' });
  const file = join(f.root, 'input.txt'),
    moved = join(f.root, 'opened.txt');
  try {
    const bytes = readBoundedBytes(file, 8, (opened) => {
      renameSync(file, moved);
      writeFileSync(file, 'replacement');
      expect(opened.ino).toBe(statSync(moved).ino);
    });
    expect(bytes.toString()).toBe('original');
    expect(() =>
      readBoundedBytes(file, 20, () => {
        throw Error('Rejected open file');
      }),
    ).toThrow('Rejected open file');
  } finally {
    f.dispose();
  }
});
it('accepts an exact byte limit and rejects excess, invalid JSON and non-files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fantasy-bounded-'));
  const file = join(dir, 'data.json');
  try {
    writeFileSync(file, '{"n":1}');
    expect(readBoundedJson(file, 7)).toEqual({ n: 1 });
    expect(() => readBoundedJson(file, 6)).toThrow(/oversized/);
    writeFileSync(file, 'invalid');
    expect(() => readBoundedJson(file, 7)).toThrow(SyntaxError);
    expect(() => readBoundedJson(dir)).toThrow(/Invalid or oversized input|EISDIR/);
    expect(() => readBoundedJson(file, 0)).toThrow(/budget/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
