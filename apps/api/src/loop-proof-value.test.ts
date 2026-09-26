import { it, expect } from 'vite-plus/test';
import { value } from './loop-proof-value.ts';
it('returns one', () => {
  expect(value).toBe(1);
});
