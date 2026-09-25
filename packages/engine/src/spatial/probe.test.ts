import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vite-plus/test';
import { initializePhysics } from './world/physics.ts';
import { probeInputs, runProbe } from './world/probe.ts';

beforeAll(initializePhysics);
const fixtures = JSON.parse(
  readFileSync(new URL('../../fixtures/spatial/probe.json', import.meta.url), 'utf8'),
) as { name: string; inputHash: string; digest: string }[];
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
it.each(probeInputs)(
  'reproduces the full 6000-step $name geometry fixture on both CI platforms',
  (input) => {
    const fixture = fixtures.find((row) => row.name === input.name)!;
    expect(sha(input)).toBe(fixture.inputHash);
    expect(sha(runProbe(input))).toBe(fixture.digest);
  },
  60_000,
);
