import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vite-plus/test';
import { inspectUiDiagnostics } from './ui-results.ts';
import { uiIdentity, writeUiProbe } from './test-support/ui.ts';
import type { UI_FAULTS } from '../../e2e/contract.ts';

const identity = uiIdentity;
const run = { id: '10', attempt: '1' };
const probe = (root: string, scenario: (typeof UI_FAULTS)[number]) =>
  writeUiProbe(root, scenario, run);

it('requires all fault types, actual failure outcomes, retained artifacts and the current CI attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-ui-diagnostics-'));
  try {
    for (const scenario of ['startup', 'timeout', 'crash'] as const) probe(root, scenario);
    expect(inspectUiDiagnostics(root, identity, run).status).toBe('pass');
    expect(inspectUiDiagnostics(root, identity, { ...run, attempt: '2' }).status).toBe('unknown');
    for (const [file, field, value] of [
      ['command.json', 'exitCode', 0],
      ['command.json', 'temporaryRemoved', false],
      ['command.json', 'scenario', 'smoke'],
      ['report.json', 'producer', 'ui-runner'],
    ] as const) {
      const path = join(root, 'diagnostics/crash', file);
      const original = readFileSync(path, 'utf8');
      const data = JSON.parse(original) as Record<string, unknown>;
      data[field] = value;
      writeFileSync(path, JSON.stringify(data));
      expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
      writeFileSync(path, original);
    }
    const path = join(root, 'diagnostics/crash/lifecycle.json');
    const commandPath = join(root, 'diagnostics/crash/command.json');
    const original = readFileSync(path, 'utf8');
    const commandText = readFileSync(commandPath, 'utf8');
    const sequence = JSON.parse(original) as { stage: string; at: string }[];
    for (const value of [
      [],
      sequence.slice(1),
      sequence.toReversed(),
      sequence.map((entry, i) => (i === 2 ? { ...entry, at: '2026-09-24T00:00:00Z' } : entry)),
    ]) {
      writeFileSync(path, JSON.stringify(value));
      const command = JSON.parse(commandText) as { digests: Record<string, string> };
      command.digests['lifecycle.json'] = createHash('sha256')
        .update(readFileSync(path))
        .digest('hex');
      writeFileSync(commandPath, JSON.stringify(command));
      expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
    }
    writeFileSync(path, original);
    writeFileSync(commandPath, commandText);
    rmSync(join(root, 'diagnostics/timeout/trace.zip'));
    expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
    rmSync(join(root, 'diagnostics/startup'), { recursive: true });
    expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
