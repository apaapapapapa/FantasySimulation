import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vite-plus/test';
import { readBoundedJson } from './files.ts';
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
