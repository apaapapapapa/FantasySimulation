import { expect, it } from 'vite-plus/test';
import { summarizeLeagueMeasurements } from './league-measurements.ts';
const observation = (id: string, times: number[]) => ({
  schemaVersion: 1,
  status: 'completed',
  observationId: id,
  identity: { sourceSha: 'a'.repeat(40), runId: '12', runAttempt: '1' },
  cpu: { userMs: 1, systemMs: 2 },
  incompleteSpans: 0,
  droppedRecords: 0,
  matches: times.map((wallMs) => ({ wallMs, storedBytes: 10, worker: { computeMs: wallMs / 2 } })),
  validation: { calls: 2, replays: { same: { calls: 2, failures: 0 } } },
});
it('uses all match samples across unequal partitions and deduplicates replay identities', () => {
  const result = summarizeLeagueMeasurements([
    observation('one', [100]),
    observation('two', [1, 2, 3]),
  ]);
  expect(result).toMatchObject({
    observedCpuMs: 6,
    observedStoredReplayBytes: 40,
    matchMetrics: { wallMs: { count: 4, median: 2.5, p95: 100, max: 100 } },
    validation: { calls: 4, uniqueReplays: 1, repeatedCalls: 3 },
    workflowWallMs: null,
  });
});
it('rejects duplicate, mixed-identity and malformed observations and exposes incomplete runs', () => {
  const a = observation('one', [1]);
  expect(() => summarizeLeagueMeasurements([a, a])).toThrow('Duplicate');
  expect(() =>
    summarizeLeagueMeasurements([
      a,
      { ...observation('two', [2]), identity: { ...a.identity, runAttempt: '2' } },
    ]),
  ).toThrow('Mixed');
  expect(() => summarizeLeagueMeasurements([{ ...a, matches: [{ wallMs: -1 }] }])).toThrow(
    'number',
  );
  expect(
    summarizeLeagueMeasurements([{ ...a, status: 'failed', incompleteSpans: 1 }])
      .incompleteObservations,
  ).toBe(2);
});
