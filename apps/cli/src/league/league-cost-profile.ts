import { distribution, type Measurements } from '@fantasy/api/tooling';
import { OperationError } from '@fantasy/api/artifacts';
import { join } from 'node:path';
import {
  canonicalJson,
  contentHash,
  LeagueCostProfileSchema,
  type ExecutionSource,
  type LeagueCloudPrepared,
} from '@fantasy/domain/spatial';
import { cloudInput } from './league-cloud-files.ts';
import { optionalPublicationFile } from '../publication/publication-files.ts';

export async function leagueCostProfile(
  source: ExecutionSource,
  matches: ReturnType<Measurements['report']>['matches'],
) {
  return LeagueCostProfileSchema.parse({
    schemaVersion: 1,
    source,
    measurementHash: await contentHash(matches),
    metric: 'worker-compute-elapsed-ms',
    samples: matches.map((match) => ({
      simulationHash: match.simulationHash,
      scenario: match.scenario,
      characters: [...match.participants].sort(),
      elapsedMs: match.worker?.computeMs,
    })),
  });
}

export async function preparedLeagueCosts(
  root: string,
  prepared: LeagueCloudPrepared,
  required = false,
) {
  const data = await optionalPublicationFile(join(root, 'cost-profile.json'), 4000000);
  if (!data) {
    if (required)
      throw new OperationError('INPUT_INVALID', 'Measured league cost profile required');
    return new Map<string, number>();
  }
  const profile = LeagueCostProfileSchema.parse(JSON.parse(data.toString('utf8')));
  const groups = new Map<string, number[]>();
  const pairKey = (scenario: string, characters: string[]) =>
    canonicalJson([scenario, [...characters].sort()]);
  for (const sample of profile.samples) {
    for (const key of ['all', sample.scenario, pairKey(sample.scenario, sample.characters)]) {
      const values = groups.get(key) ?? [];
      values.push(sample.elapsedMs);
      groups.set(key, values);
    }
  }
  const medians = new Map(
    [...groups].map(([key, values]) => [key, Math.max(1, Math.ceil(distribution(values).median!))]),
  );
  const costs = new Map<string, number>();
  for (let index = 0; index < prepared.inputs.length; index++) {
    const input = await cloudInput(root, prepared, index);
    let cost = 0;
    for (const slot of input.batch.slots) {
      cost +=
        medians.get(
          pairKey(
            slot.spec.scenario.id,
            slot.spec.participants.map((p) => p.character.id),
          ),
        ) ??
        medians.get(slot.spec.scenario.id) ??
        medians.get('all')!;
    }
    costs.set(input.partition.id, cost);
  }
  return costs;
}
