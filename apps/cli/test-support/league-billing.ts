import type { LeagueBillingObservation } from '@fantasy/domain/spatial';

export function billingObservation(day = '2026-09-25'): LeagueBillingObservation {
  return {
    accountId: 'a'.repeat(32),
    bucket: 'fixture-bucket',
    storageClass: 'Standard',
    provenance: 'operator-verified-account-usage',
    evidenceDigest: `sha256:${'c'.repeat(64)}`,
    cycleStart: '2026-09-12T00:00:00Z',
    cycleEnd: '2026-10-12T00:00:00Z',
    observedAt: day + 'T12:00:00Z',
    classAUsed: 0,
    classBUsed: 0,
    otherClassAReserve: 0,
    otherClassBReserve: 0,
    workerDay: day,
    workerRemaining: 90000,
  };
}
