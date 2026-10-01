import {
  BattleSensorProjectionSchema,
  compareIds,
  deepFreeze,
  parseJson,
  replayChunkRecords,
  replayContext,
  seekReplayState,
  type ActorDisplay,
  type ReplayManifest,
} from '@fantasy/domain/spatial';
import type { ArtifactStore } from './artifact-store.ts';
import { readCompressed } from './replay-files.ts';

const FEATURE = 'environmental-holograms-v1';
type CompressedRef = ReplayManifest['chunks'][number] | ReplayManifest['checkpoints'][number];

export function sanitizeEnvironmentalHologramSensorProjection(
  replayId: string,
  step: number,
  actors: readonly ActorDisplay[],
) {
  return parseJson(BattleSensorProjectionSchema, {
    replayId,
    step,
    observers: [...actors]
      .sort((left, right) => compareIds(left.id, right.id))
      .slice(0, 2)
      .map((actor) => ({
        observerId: actor.id,
        environmentalHolograms: [...(actor.sensorView?.environmentalHolograms ?? [])]
          .sort((left, right) => compareIds(left.id, right.id))
          .slice(0, 8)
          .map(({ sourcePosition: _, ...hologram }) => hologram),
      })),
  });
}

/**
 * Read the final recorded sensor state through the DB-bound manifest and checked artifact refs.
 * The response intentionally omits sourcePosition: truth geometry and engine-private state remain
 * available only in the public replay artifact, never in this bounded observer projection.
 */
export async function environmentalHologramSensorProjection(
  artifacts: ArtifactStore,
  replayId: string,
  expectedAttemptId: string,
) {
  const files = await artifacts.files(replayId, expectedAttemptId);
  if (files.manifest.attemptId !== expectedAttemptId)
    throw new Error('Replay/attempt manifest binding mismatch');
  if (files.manifest.input.schemaVersion < 8) return undefined;
  const context = await replayContext(files.manifest.input, files.manifest.simulationHash);
  const expand = (ref: CompressedRef) => readCompressed('', ref, (file) => files.read(file));
  const replay = await seekReplayState(context, files.manifest, files.manifest.records, {
    checkpoint: async (index) =>
      JSON.parse(await expand(files.manifest.checkpoints[index]!)) as unknown,
    records: async (index) => {
      const ref = files.manifest.chunks[index]!;
      return replayChunkRecords(await expand(ref), ref);
    },
  });
  const checkpoint = replay.checkpoint();
  if (!checkpoint.requiredFeatures?.includes(FEATURE)) return undefined;
  if (!checkpoint.state) throw new Error('Completed replay has no display state');
  const projection = sanitizeEnvironmentalHologramSensorProjection(
    replayId,
    checkpoint.step,
    checkpoint.state.actors,
  );
  return deepFreeze(projection);
}
