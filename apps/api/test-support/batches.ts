import { catalogManifest } from '@fantasy/engine/spatial';
import {
  DEFAULT_BUDGET,
  BatchInputSchema,
  ExecutionSourceSchema,
  SpecInputSchema,
} from '@fantasy/domain/spatial';

/** Synthetic source identity is fixture data, not a receipt claiming a real checkout. */
export const batchSource = ExecutionSourceSchema.parse({
  sha: 'a'.repeat(40),
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
});
export async function batchInput(count = 4) {
  const manifest = await catalogManifest('archer', 'guardian', 'flat', 30);
  const matches = [];
  for (let seed = 1; seed <= count; seed++) {
    const { participants, ruleset, scenario } = await catalogManifest(
      'archer',
      'guardian',
      'flat',
      30,
      seed,
    );
    matches.push({
      key: `match-${seed}`,
      spec: SpecInputSchema.parse({ seed, participants, ruleset, scenario }),
    });
  }
  return BatchInputSchema.parse({
    schemaVersion: 1,
    revisions: manifest.revisions,
    matches,
    budget: DEFAULT_BUDGET,
    estimatedBytesPerMatch: 1024 ** 2,
    maxOutputBytes: 32 * 1024 ** 2,
    maxWorkBytes: 256 * 1024 ** 2,
  });
}
