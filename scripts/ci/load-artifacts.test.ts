import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vite-plus/test';
import { readLoadArtifacts } from './load-artifacts.ts';
import { loadFixture, loadReceipts } from '../harness/test-support/load.ts';
import { bytesHash, fixtureHash } from '../harness/load-contract.ts';

it('requires raw load trials and commands even when the summary reports success', () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-load-artifacts-'));
  const write = (path: string, data: unknown) =>
    writeFileSync(join(root, path), JSON.stringify(data));
  try {
    for (const path of [
      '.github/harness',
      'packages/engine/fixtures/spatial',
      'scripts/harness',
      'evidence',
    ])
      mkdirSync(join(root, path), { recursive: true });
    const { after, profile, info } = loadFixture();
    write('.github/harness/load-profile.json', profile);
    write('packages/engine/fixtures/spatial/corpus.json', { fixed: 'input' });
    write('scripts/harness/load-capture.ts', 'synthetic driver bytes');
    for (const [key, path] of [
      ['profileHash', '.github/harness/load-profile.json'],
      ['corpusHash', 'packages/engine/fixtures/spatial/corpus.json'],
      ['driverHash', 'scripts/harness/load-capture.ts'],
    ] as const)
      after[key] = bytesHash(readFileSync(join(root, path)));
    after.fixtureHash = fixtureHash({ fixed: 'input' });
    const report = loadReceipts(info)['load-ubuntu-latest'];
    write('evidence/report.json', report);
    write('evidence/results.json', { after, before: null, previousProfile: null });
    write('evidence/0-after.json', after);
    write('evidence/commands.json', {
      runnerId: after.runnerId,
      errors: [],
      commands: [{ output: 'capture.log' }],
    });
    write('evidence/performance.json', { elapsedMs: 1 });
    write('evidence/capture.log', 'completed');
    const read = () => readLoadArtifacts(root, join(root, 'evidence'), info, false);
    expect(read()).toEqual(report);
    for (const file of [
      'results.json',
      '0-after.json',
      'commands.json',
      'performance.json',
      'capture.log',
    ]) {
      const path = join(root, 'evidence', file),
        bytes = readFileSync(path);
      rmSync(path);
      expect(read).toThrow(Error);
      writeFileSync(path, bytes);
    }
    write('evidence/0-after.json', { ...after, sourceSha: 'f'.repeat(40) });
    expect(read).toThrow(/Stale raw trial/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
