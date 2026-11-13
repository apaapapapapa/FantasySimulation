import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vite-plus/test';
import { initializePhysics } from './world/physics.ts';
import { probeInputs, runProbe } from './world/probe.ts';

beforeAll(initializePhysics);
const fixtures = JSON.parse(
  readFileSync(new URL('../../fixtures/spatial/probe.json', import.meta.url), 'utf8'),
) as { name: string; inputHash: string; geometry: string; digest: string }[];
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Vitest 5 no longer quotes string values; keep the corpus-mapped test names.
it.each(probeInputs)(
  "reproduces the full 6000-step '$name' geometry fixture on both CI platforms",
  (input) => {
    const fixture = fixtures.find((row) => row.name === input.name)!;
    expect(sha(input)).toBe(fixture.inputHash);
    const run = runProbe(input);
    // Rapier upgrades may change snapshot bytes; geometry must still match its pinned outcome.
    expect(sha({ checkpoints: run.checkpoints, casts: run.casts })).toBe(fixture.geometry);
    expect(sha(run)).toBe(fixture.digest);
  },
  60_000,
);
