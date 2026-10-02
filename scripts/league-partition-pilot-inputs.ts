import { join } from 'node:path';
import { canonicalJson, contentHash, LeagueDefinitionSchema } from '@fantasy/domain/spatial';
import {
  normalizeLeagueDefinition,
  leagueCoordinates,
  ManifestBuilder,
} from '@fantasy/engine/spatial';
import {
  cloudJson,
  cloudInput,
  preparedLeague,
} from '../apps/cli/src/league/league-cloud-files.ts';
import { optionalPublicationFile } from '../apps/cli/src/publication/publication-files.ts';
import { requirePipelineCapacityEvidence } from './league-pipeline-policy.ts';
import type { PipelineIdentity } from '../apps/cli/src/league/league-producer.ts';
import { calibrationRunners, requireCalibrationScope } from './league-runner-calibration-policy.ts';

export function partitionPilotRunners(value: number) {
  if (value !== 1 && value !== 2) throw new Error('Partition pilot requires one or two runners');
  return value;
}

/** The original 380 aerial/trial-zero inputs, including both placements and unchanged seed. */
export async function partitionPilotInputs() {
  const original = LeagueDefinitionSchema.parse(
    await cloudJson('data/leagues/official-20-balanced-v1.json'),
  );
  const normalized = await normalizeLeagueDefinition(original);
  const aerial = normalized.battlefields.find(
    (field) => field.scenario.id === 'aerial-surveyed-v1',
  );
  if (!aerial) throw new Error('Original aerial field missing');
  const definition = await normalizeLeagueDefinition({
    ...normalized,
    trials: 1,
    battlefields: [{ ...aerial, weight: { numerator: '1', denominator: '1' } }],
  });
  requirePipelineCapacityEvidence(definition, 2);
  for (const [candidate, runners] of [
    [original, 1],
    [definition, 5],
  ] as const) {
    let held = false;
    try {
      requirePipelineCapacityEvidence(candidate, runners);
    } catch {
      held = true;
    }
    if (!held) throw new Error('Full-size or scale-up capacity hold lost');
  }
  const builder = ManifestBuilder.from(normalized.revisions);
  const originals = new Map<string, string>();
  for await (const entry of leagueCoordinates(normalized)) {
    if (entry.slot.scenario.id === aerial.scenario.id && entry.slot.trial === 0) {
      const battle = await builder.build(entry.spec);
      originals.set(
        entry.slot.id,
        canonicalJson({
          ...entry,
          manifest: battle.manifest,
          simulationHash: battle.simulationHash,
        }),
      );
    }
  }
  const expected = [];
  for await (const entry of leagueCoordinates(definition)) {
    const battle = await builder.build(entry.spec);
    if (
      originals.get(entry.slot.id) !==
      canonicalJson({ ...entry, manifest: battle.manifest, simulationHash: battle.simulationHash })
    )
      throw new Error('Original pilot inputs changed');
    expected.push({
      index: expected.length,
      slotId: entry.slot.id,
      simulationHash: battle.simulationHash,
      specHash: await contentHash(entry.spec),
      manifestHash: await contentHash(battle.manifest),
    });
  }
  if (
    expected.length !== 380 ||
    new Set(expected.map((entry) => entry.simulationHash)).size !== 380
  )
    throw new Error('Requires exactly 380 original inputs');
  return {
    definition,
    expected,
    definitionHash: await contentHash(definition),
    originalDefinitionHash: await contentHash(original),
  };
}

export function validatePartitionPilotPrepared(
  root: string,
  identity: PipelineIdentity,
  runners: number,
) {
  partitionPilotRunners(runners);
  return validatePilotPrepared(root, identity, runners, false);
}

export function validateCalibrationPrepared(
  root: string,
  identity: PipelineIdentity,
  runners: number,
) {
  calibrationRunners(runners);
  return validatePilotPrepared(root, identity, runners, true);
}

async function validatePilotPrepared(
  root: string,
  identity: PipelineIdentity,
  runners: number,
  calibration: boolean,
) {
  if (await optionalPublicationFile(join(root, 'cost-profile.json'), 4000000))
    throw new Error(
      'Partition pilot requires the registered default assignment, not profile hints',
    );
  const registered = await partitionPilotInputs();
  const prepared = await preparedLeague(root);
  if (canonicalJson(prepared.plan.source) !== canonicalJson(identity.source))
    throw new Error('Partition pilot source mismatch');
  if (prepared.executionId !== `league-${identity.runId}-${identity.runAttempt}`)
    throw new Error('Partition pilot execution mismatch');
  if (calibration) requireCalibrationScope(prepared, runners, identity);
  else if (prepared.inputs.length !== 3)
    throw new Error('Partition pilot partition coverage mismatch');
  if ((await contentHash(prepared.plan.revision.definition)) !== registered.definitionHash)
    throw new Error('Partition pilot definition mismatch');
  if (prepared.plan.partitions.reduce((n, partition) => n + partition.slots, 0) !== 380)
    throw new Error('Partition pilot slot coverage mismatch');
  const expected = new Map(registered.expected.map((entry) => [entry.simulationHash, entry]));
  const seen = new Set<string>();
  for (let index = 0; index < prepared.inputs.length; index++) {
    const input = await cloudInput(root, prepared, index);
    for (const slot of input.batch.slots) {
      const wanted = expected.get(slot.simulationHash);
      if (
        !wanted ||
        seen.has(slot.simulationHash) ||
        (await contentHash(slot.spec)) !== wanted.specHash
      )
        throw new Error('Partition pilot original input or uniqueness mismatch');
      seen.add(slot.simulationHash);
    }
    if (
      input.reservation.progress.records.length !== input.batch.slots.length ||
      input.reservation.progress.records.some(
        (record) =>
          record.attempts.length !== 1 ||
          record.attempts[0]!.state !== 'reserved' ||
          record.attempts[0]!.executionId !== prepared.executionId,
      )
    )
      throw new Error('Partition pilot requires newly reserved inputs');
  }
  if (seen.size !== 380) throw new Error('Partition pilot requires 380 new inputs');
  return { registered, prepared };
}
