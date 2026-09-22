import fc from 'fast-check';
import { expect, it } from 'vite-plus/test';
import { checkProperty } from './test-support/property.ts';

it('does not count an interrupted or discarded property as a passing run', async () => {
  const file = 'scripts/harness/property-report.test.ts';
  await expect(
    checkProperty(
      'interruption-control',
      file,
      fc.asyncProperty(fc.boolean(), async () => true),
      {
        interruptAfterTimeLimit: 0,
      },
    ),
  ).rejects.toThrow(/interrupted/);
  await expect(
    checkProperty(
      'discard-control',
      file,
      fc.asyncProperty(fc.boolean(), async () => {
        fc.pre(false);
      }),
      {
        maxSkipsPerRun: 0,
      },
    ),
  ).rejects.toThrow(/failed/);
});
