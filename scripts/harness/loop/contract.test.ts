import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET, parseContract, pathAllowed } from './contract.ts';
import { initialize, readJournal } from './journal.ts';
import { begin, status, transition } from './state.ts';
import { loopCommand } from './cli.ts';

export const exampleContract = () => ({
  schemaVersion: 1,
  repository: 'owner/repo',
  baselineSha: 'a'.repeat(40),
  goal: 'Repair a reproducible input failure',
  allowedPaths: ['apps/web/src'],
  requiredChecks: ['source-clean', 'source-verify'],
  budget: { ...DEFAULT_BUDGET },
  review: 'optional',
  reviewWaitMs: 900_000,
  target: 'pr',
});
const time = '2026-09-23T00:00:00.000Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-loop-'));
  const path = initialize(root, exampleContract(), time);
  const mutate = (type: string, data: Record<string, unknown>, at = time) =>
    transition(path, readJournal(path), type, data, at);
  return { root, path, mutate, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
describe('frozen manual loop contract', () => {
  it.each([
    'scripts',
    '.github',
    'apps/web/package.json',
    'apps/web/src/AGENTS.md',
    'apps/web/src/fixtures',
    'apps/web/src/../x',
    'packages/engine/src/spatial/implementation.json',
  ])('protects %s', (path) => {
    expect(() => parseContract({ ...exampleContract(), allowedPaths: [path] })).toThrow();
  });
  it('keeps the default paid budget at zero and source gates mandatory', () => {
    const contract = parseContract(exampleContract());
    expect(pathAllowed(contract, 'apps/web/src/new.test.ts')).toBe(true);
    expect(() =>
      parseContract({ ...contract, budget: { ...contract.budget, costMicros: 1 } }),
    ).toThrow();
    expect(() => parseContract({ ...contract, requiredChecks: ['custom'] })).toThrow();
    expect(() =>
      parseContract({ ...contract, requiredChecks: [...contract.requiredChecks, 'custom'] }),
    ).toThrow();
  });
  it('reuses one journal and refuses reset or changed budgets', () => {
    const f = fixture();
    try {
      f.mutate('prepared', { workspace: '/owned' });
      begin(f.path, { hypothesis: 'First attempt', externalCalls: 10, costMicros: 0 }, time);
      expect(initialize(f.root, exampleContract(), time)).toBe(f.path);
      expect(status(readJournal(f.path), time).externalCalls).toBe(10);
      expect(() =>
        initialize(
          f.root,
          { ...exampleContract(), budget: { ...DEFAULT_BUDGET, attempts: 10 } },
          time,
        ),
      ).toThrow();
      expect(() =>
        begin(f.path, { hypothesis: 'Duplicate begin', externalCalls: 0, costMicros: 0 }, time),
      ).toThrow();
      f.mutate('interrupted', { reason: 'Previous process ended; owned checkout reconciled' });
      expect(status(readJournal(f.path), time)).toMatchObject({
        attempts: 1,
        externalCalls: 10,
        noProgress: 1,
      });
    } finally {
      f.dispose();
    }
  });
  it('fences stale writers and surviving locks without losing reservations', () => {
    const f = fixture();
    try {
      const stale = readJournal(f.path);
      f.mutate('prepared', { workspace: '/owned' });
      expect(() => transition(f.path, stale, 'prepared', { workspace: '/another' }, time)).toThrow(
        /revision/,
      );
      writeFileSync(f.path + '.lock', 'interrupted owner');
      expect(() =>
        begin(f.path, { hypothesis: 'locked', externalCalls: 1, costMicros: 0 }, time),
      ).toThrow();
      expect(readJournal(f.path).revision).toBe(2);
    } finally {
      f.dispose();
    }
  });
  it('rejects oversized initial journals without poisoning future initialization', () => {
    const root = mkdtempSync(join(tmpdir(), 'fantasy-loop-size-'));
    try {
      expect(() =>
        initialize(
          root,
          { ...exampleContract(), allowedPaths: ['src/' + 'x'.repeat(4 * 1024 * 1024)] },
          time,
        ),
      ).toThrow(/size/);
      const path = initialize(root, exampleContract(), time);
      expect(readJournal(path).revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('cannot interrupt an unprepared journal into an active attempt', () => {
    const f = fixture();
    try {
      expect(() => f.mutate('interrupted', { reason: 'Process exited' })).toThrow(/active/);
      expect(status(readJournal(f.path), time).phase).toBe('initialized');
      f.mutate('prepared', { workspace: '/owned' });
      expect(status(readJournal(f.path), time).phase).toBe('ready');
    } finally {
      f.dispose();
    }
  });
  it('reports completion consistently when init resumes a completed journal', async () => {
    const f = fixture();
    try {
      f.mutate('prepared', { workspace: '/owned' });
      begin(f.path, { hypothesis: 'Repair', externalCalls: 0, costMicros: 0 }, time);
      const candidateSha = 'b'.repeat(40),
        patchHash = 'c'.repeat(64);
      f.mutate('applying', { baseSha: 'a'.repeat(40), patchHash });
      f.mutate('applied', { candidateSha, patchHash });
      f.mutate('evaluated', { candidateSha, outcome: 'pass', passed: 2, evidence: 'source' });
      f.mutate('regression', { candidateSha, evidence: 'regression' });
      f.mutate('reviewed', {
        candidateSha,
        method: 'human',
        unresolvedFindings: 0,
        evidence: 'review',
      });
      f.mutate('observed', { candidateSha, complete: true, evidence: 'ci' });
      const input = join(f.root, 'contract.json');
      writeFileSync(input, JSON.stringify(exampleContract()));
      expect(await loopCommand(['init', f.root, input])).toMatchObject({
        phase: 'completed',
        repairComplete: true,
      });
    } finally {
      f.dispose();
    }
  });
  it('does not extend deadlines on status and detects edited history', () => {
    const f = fixture();
    try {
      const before = readFileSync(f.path, 'utf8');
      expect(status(readJournal(f.path), '2026-09-23T01:00:00.000Z').phase).toBe('stopped');
      expect(readFileSync(f.path, 'utf8')).toBe(before);
      const invalid = JSON.parse(before);
      invalid.events[0].at = '2026-09-23T00:30:00.000Z';
      writeFileSync(f.path, JSON.stringify(invalid));
      expect(() => readJournal(f.path)).toThrow();
    } finally {
      f.dispose();
    }
  });
});
