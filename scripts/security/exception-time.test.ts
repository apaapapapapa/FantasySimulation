import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExceptionTime } from './exception-time.ts';
import { exceptions } from './secrets.ts';

await test('exception timestamps reject incomplete or normalized calendar values', () => {
  for (const value of [
    '2026-09-21',
    '09/21/2026',
    '2026-09-21T00:00:00',
    '2026-09-21T00:00:00+00:00',
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-09-21T24:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-09-21T00:00:00.1Z',
    '2026-09-21T00:00:00Z ',
  ]) {
    assert.throws(() => parseExceptionTime(value));
  }
});

await test('valid leap days and UTC timestamps preserve the exact instant', () => {
  for (const value of [
    '2024-02-29T23:59:59Z',
    '2026-09-21T00:00:00Z',
    '2026-09-21T00:00:00.123Z',
  ]) {
    assert.equal(parseExceptionTime(value), Date.parse(value));
  }
});

await test('exception boundary rejects invalid review and expiry even inside the budget', () => {
  const entry = {
    fingerprintSha256: 'a'.repeat(64),
    reason: 'Confirmed synthetic test fixture, not an issued credential.',
    reviewer: 'maintainer',
    reviewedAt: '2026-03-01T00:00:00Z',
    expiresAt: '2026-03-08T00:00:00Z',
  };
  const now = Date.parse('2026-03-03T00:00:00Z');
  assert.equal(exceptions([entry], now).size, 1);
  for (const reviewedAt of ['2026-03-01', '2026-02-30T00:00:00Z']) {
    assert.throws(() => exceptions([{ ...entry, reviewedAt }], now));
  }
  assert.throws(() => exceptions([{ ...entry, expiresAt: '2026-03-08' }], now));
});
