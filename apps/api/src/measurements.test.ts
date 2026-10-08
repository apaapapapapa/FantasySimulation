import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  Measurements,
  distribution,
  measureAsync,
  measureSync,
  currentMeasurements,
  type VerificationWorkerStages,
} from './measurements.ts';

afterEach(() => vi.restoreAllMocks());
it('bounds per-call verification observations and keeps rejected diagnostics out of the report', () => {
  const measured = new Measurements();
  const value = {
    replayId: 'replay-a',
    stage: 'validate.replay' as const,
    success: false,
    attempted: true,
    observation: {
      threadId: 2,
      elapsedMs: 10,
      cpuUserMs: 3,
      cpuSystemMs: 1,
      gcCount: 2,
      gcDurationMs: 0.5,
    },
  };
  measured.verificationObservation(value);
  for (const observation of [
    { ...value.observation, gcCount: 0.5 },
    { ...value.observation, threadId: -1 },
    { ...value.observation, cpuUserMs: Infinity },
    { ...value.observation, elapsedMs: Number.NaN },
    { ...value.observation, extra: 1 },
    {},
  ])
    expect(() => measured.verificationObservation({ ...value, observation })).toThrow();
  expect(() => measured.verificationObservation({ ...value, replayId: 'x'.repeat(513) })).toThrow();
  expect(measured.report().verificationWorkerObservations).toEqual([value]);
  for (let i = 1; i <= 20000; i++) measured.verificationObservation(value);
  value.observation.gcCount = 99;
  const report = measured.report();
  expect(report.verificationWorkerObservations).toHaveLength(20000);
  expect(report.verificationWorkerObservations[0]!.observation.gcCount).toBe(2);
  expect(report.droppedRecords).toBe(1);
  expect(report.stages).toEqual({});
  expect(report.measuredSpanUnionMs).toBe(0);
  expect(report.validation.calls).toBe(0);
});
it('keeps bounded Worker stages separate from process-local spans and preserves failures', () => {
  const measured = new Measurements();
  const stage = {
    count: 2,
    failures: 1,
    bytes: 123,
    inclusiveMs: 10,
    busyWallMs: 8,
    incomplete: 1,
  };
  measured.verificationStages({ decompress: stage });
  measured.verificationStages({ decompress: stage });
  const report = measured.report();
  expect(report.verificationWorkerStages.decompress).toEqual({
    count: 4,
    failures: 2,
    bytes: 246,
    inclusiveMs: 20,
    busyWallSumMs: 16,
    incomplete: 2,
  });
  expect(report.stages).toEqual({});
  expect(report.measuredSpanUnionMs).toBe(0);
  expect(report.incompleteSpans).toBe(0);
  for (const invalid of [
    { unknown: stage },
    { decompress: { ...stage, inclusiveMs: Infinity } },
    { decompress: { ...stage, count: -1 } },
    { decompress: { ...stage, extra: 1 } },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['unknown-' + i, stage])),
  ]) {
    expect(() => measured.verificationStages(invalid as VerificationWorkerStages)).toThrow();
    expect(measured.report().verificationWorkerStages).toEqual(report.verificationWorkerStages);
  }
});
it('unions nested and concurrent intervals instead of adding work to wall time', () => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const m = new Measurements();
  const a = m.start('save');
  clock = 10;
  const b = m.start('save');
  clock = 15;
  const c = m.start('hash');
  clock = 20;
  a();
  clock = 25;
  c(false);
  clock = 30;
  b();
  b();
  clock = 40;
  expect(m.report()).toMatchObject({
    wallMs: 40,
    measuredSpanUnionMs: 30,
    unseparatedMs: 10,
    incompleteSpans: 0,
    stages: {
      save: { count: 2, inclusiveMs: 40, busyWallMs: 30 },
      hash: { count: 1, failures: 1, inclusiveMs: 10 },
    },
  });
});
it('reports unfinished spans, missing samples and exact nearest-rank quantiles', () => {
  const m = new Measurements();
  m.start('interrupted');
  expect(m.report()).toMatchObject({
    incompleteSpans: 1,
    matchWallMs: { median: null, p95: null, max: null },
  });
  expect(distribution([4, 1, 20, 3])).toEqual({ count: 4, median: 3.5, p95: 20, max: 20 });
  expect(distribution(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
});
it('preserves values and exact errors and isolates concurrent measurement contexts', async () => {
  const a = new Measurements(),
    b = new Measurements(),
    error = new Error('sentinel');
  await Promise.all([
    a.run(async () => {
      expect(measureSync('hash', () => 42)).toBe(42);
      await expect(
        measureAsync('read', async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(() =>
        measureSync('syncFailure', () => {
          throw error;
        }),
      ).toThrow(error);
    }),
    b.run(async () => {
      await measureAsync('write', async () => 'ok');
    }),
  ]);
  expect(currentMeasurements()).toBeUndefined();
  expect(a.report().stages).not.toHaveProperty('write');
  expect(b.report().stages).not.toHaveProperty('hash');
  expect(a.report().stages.read).toMatchObject({ count: 1, failures: 1 });
});
it('retains runner CPU/scheduler context and worker GC observations', () => {
  const measured = new Measurements();
  measured.match({
    simulationHash: 'sha256:' + 'a'.repeat(64),
    attemptId: 'attempt-1',
    scenario: 'fixture',
    participants: ['a', 'b'],
    outcome: 'draw',
    wallMs: 10,
    worker: { gcCount: 2, gcDurationMs: 3.5 },
  });
  const report = measured.report();
  expect(report.cpu.hardware.logicalProcessors).toBeGreaterThan(0);
  expect(report.cpu.hardware.speedMHz.count).toBe(report.cpu.hardware.logicalProcessors);
  expect(report.cpu.scheduler.voluntaryContextSwitches).toBeGreaterThanOrEqual(0);
  expect(report.cpu.scheduler.involuntaryContextSwitches).toBeGreaterThanOrEqual(0);
  expect(report.workerMetrics).toMatchObject({
    gcCount: { count: 1, median: 2, p95: 2, max: 2 },
    gcDurationMs: { count: 1, median: 3.5, p95: 3.5, max: 3.5 },
  });
});
it('counts every verification, including repeats and rejected replays, without retaining payloads', () => {
  const m = new Measurements();
  m.validation('replay-a', true);
  m.validation('replay-a', false);
  m.validation('replay-b', true);
  expect(m.report().validation).toMatchObject({
    calls: 3,
    uniqueReplays: 2,
    repeatedCalls: 1,
    replays: { 'replay-a': { calls: 2, failures: 1 } },
  });
});
