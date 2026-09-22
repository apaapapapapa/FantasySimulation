import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renovateOutcome } from './toolchain.ts';

await test('the single Renovate configuration is strict JSON and keeps automerge disabled', () => {
  const file = new URL('../../renovate.json', import.meta.url);
  const config = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  assert.equal(renovateOutcome(config).status, 'pass');
  assert.equal(existsSync(new URL('../../renovate.json5', import.meta.url)), false);
});
