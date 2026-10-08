import { expect, it } from 'vite-plus/test';
import { PUBLICATION_MAX_BYTES } from '@fantasy/domain/spatial';
import {
  TransportReservation,
  calibrationTransportReservation,
  multipartReservationPlan,
} from './league-transport-reservation.ts';

it('pre-reserves finite calibration job shares under unchanged byte-hour and artifact bounds', () => {
  for (const width of [2, 4]) {
    const prepare = calibrationTransportReservation('prepare', width, 0);
    const compute = calibrationTransportReservation('compute', width, 0);
    const consume = calibrationTransportReservation('consume', width, 0);
    expect(prepare.ledger.snapshot().refsUpper).toBe(3);
    expect(compute.ledger.snapshot().refsUpper).toBe(18);
    expect(consume.ledger.snapshot().refsUpper).toBe(1);
    expect(compute.globalRefsUpper).toBe(width * 18 + 4);
    expect(
      prepare.ledger.snapshot().bytesUpper +
        width * compute.ledger.snapshot().bytesUpper +
        consume.ledger.snapshot().bytesUpper,
    ).toBeLessThanOrEqual(92 * 1024 ** 2);
  }
});
it('debits uncertain attempts, forbids immutable name reuse and has no reset/refund', () => {
  const ledger = new TransportReservation(2, 100);
  ledger.reserve('failed', 40);
  expect(() => ledger.reserve('failed', 1)).toThrow('name reused');
  ledger.reserve('retry-with-new-name', 60);
  expect(ledger.snapshot()).toEqual({
    refsUpper: 2,
    bytesUpper: 100,
    reservedRefs: 2,
    reservedBytes: 100,
    refundable: false,
  });
  expect(() => ledger.reserve('third', 1)).toThrow('exhausted');
});
it('rejects overflow and invalid budgets before mutating the ledger', () => {
  expect(() => new TransportReservation(51, 100)).toThrow();
  const ledger = new TransportReservation(2, 100);
  for (const bytes of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1, 101])
    expect(() => ledger.reserve('invalid', bytes)).toThrow();
  expect(ledger.snapshot().reservedRefs).toBe(0);
  ledger.reserve('exact', 100);
});
it('plans byte-framed 60 partitions across four runners without a three-ref assumption', () => {
  const model = multipartReservationPlan(
    Array.from({ length: 4 }, (_, r) => Array.from({ length: 15 }, (_, n) => r * 15 + n)),
  );
  expect(model).toMatchObject({
    executionEnabled: false,
    status: 'reservation-only',
    globalRefsUpper: 201,
  });
  expect(model.jobs.map((job) => job.publicBytesUpper)).toEqual([
    2_000_000_000, 2_000_000_000, 2_000_000_000, 2_000_000_000,
  ]);
  expect(model.jobs.map((job) => job.payloadRefsUpper)).toEqual([47, 47, 47, 47]);
  expect(model.jobs.map((job) => job.jobRefsUpper)).toEqual([49, 49, 49, 49]);
  expect(model.encodedSegmentBytesUpper).toBe(50_331_784);
  expect(model.jobs.reduce((n, job) => n + job.publicBytesUpper, 0)).toBe(PUBLICATION_MAX_BYTES);
  expect(model.remainingGates).toContain('same-zip-sdk-upload');
  expect(model.remainingGates).toContain('same-source-whole-critical-path');
});
it('reserves all 64 partitions, retry refs and controls inside 50/job and 256/global', () => {
  const model = multipartReservationPlan(
    Array.from({ length: 4 }, (_, r) => Array.from({ length: 16 }, (_, n) => r * 16 + n)),
  );
  expect(model.globalRefsUpper).toBe(205);
  expect(model.jobs.every((job) => job.jobRefsUpper === 50)).toBe(true);
});
it.each(
  [[], [[0], [0]], [[1]], [Array.from({ length: 17 }, (_, i) => i)], [[0], [1], [2], [3], [4]]].map(
    (input) => ({ input }),
  ),
)('rejects malformed or unsupported assignments $input', ({ input }) => {
  expect(() => multipartReservationPlan(input)).toThrow();
});
it('rejects quota-insufficient smaller widths and unknown calibration scopes', () => {
  expect(() => multipartReservationPlan([[0], [1]])).toThrow('finite quota');
  expect(() => calibrationTransportReservation('compute', 3, 0)).toThrow();
  expect(() => calibrationTransportReservation('unknown', 4, 0)).toThrow();
  expect(() => calibrationTransportReservation('compute', 4, 181)).toThrow('quota');
  expect(calibrationTransportReservation('compute', 4, 180).globalRefsUpper).toBe(256);
  expect(() => calibrationTransportReservation('compute', 4, NaN)).toThrow();
});
