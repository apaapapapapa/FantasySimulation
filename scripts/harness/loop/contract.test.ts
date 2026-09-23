import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET, parseContract, pathAllowed } from './contract.ts';
import { initialize, readJournal } from './journal.ts';
import { begin, status, transition } from './state.ts';

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
