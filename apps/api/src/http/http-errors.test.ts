import { expect, it } from 'vite-plus/test';
import { createApp } from './app.ts';
import { openStore } from '../db/store.ts';
import { StoreError } from '../db/store-error.ts';

it('maps coded application failures to the existing HTTP contract only at the boundary', async () => {
  const app = createApp(openStore(':memory:'));
  const cases = [
    ['not-found', 404],
    ['conflict', 409],
    ['invalid-input', 400],
    ['queue-capacity', 429],
    ['storage-capacity', 507],
    ['unavailable', 503],
  ] as const;
  for (const [code] of cases)
    app.get(`/failure/${code}`, async () => {
      const error = new StoreError(code, 'unchanged message');
      expect('statusCode' in error).toBe(false);
      throw error;
    });
  try {
    for (const [code, status] of cases) {
      const response = await app.inject(`/failure/${code}`);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: 'unchanged message' });
    }
  } finally {
    await app.close();
  }
});
