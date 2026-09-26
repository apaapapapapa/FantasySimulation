import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { readContentSources } from './content-sources.ts';

it('discovers independent files deterministically and rejects symlink sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-content-'));
  try {
    mkdirSync(join(root, 'abilities'));
    writeFileSync(join(root, 'abilities', 'b.json'), '{"id":"b"}');
    writeFileSync(join(root, 'a.json'), '[{"id":"a"}]');
    expect(readContentSources(root).inputs).toEqual([{ id: 'a' }, { id: 'b' }]);
    symlinkSync(join(root, 'a.json'), join(root, 'alias.json'));
    expect(() => readContentSources(root)).toThrow('Unsafe content source path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
