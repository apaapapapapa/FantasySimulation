import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  lstatSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { readContentFile, readContentSources } from './content-sources.ts';

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

it('rejects a file or symlink substituted between discovery and opening', () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-content-race-'));
  const path = join(root, 'input.json'),
    saved = join(root, 'saved.json');
  try {
    writeFileSync(path, '{"id":"original"}');
    const discovered = lstatSync(path);
    expect(readContentFile(path, discovered).toString()).toBe('{"id":"original"}');
    renameSync(path, saved);
    writeFileSync(path, '{"id":"replaced"}');
    expect(() => readContentFile(path, discovered)).toThrow('Content source changed before read');
    unlinkSync(path);
    symlinkSync(saved, path);
    expect(() => readContentFile(path, discovered)).toThrow('Content source changed before read');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
