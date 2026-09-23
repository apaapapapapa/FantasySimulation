import { z } from 'zod';
import { StoredManifestSchema } from './spatial/contracts.ts';
import { ExecutionSourceSchema } from './spatial/batch.ts';
import { ReplayManifestSchema, RECORDING_PROFILE } from './spatial/replay.ts';

/** Versions understood by both the viewer and the publication preflight. */
export const SUPPORTED_REPLAY_FORMAT = Object.freeze({
  manifestSchema: ReplayManifestSchema.shape.schemaVersion.value,
  inputSchema: StoredManifestSchema.shape.schemaVersion.value,
  eventSchema: StoredManifestSchema.shape.eventSchemaVersion.value,
  replaySchema: StoredManifestSchema.shape.replaySchemaVersion.value,
  profile: RECORDING_PROFILE.id,
});
export const ViewerBuildSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceSha: ExecutionSourceSchema.shape.sha,
  publicationSchema: z.literal(1),
  replay: z.strictObject({
    manifestSchema: z.literal(SUPPORTED_REPLAY_FORMAT.manifestSchema),
    inputSchema: z.literal(SUPPORTED_REPLAY_FORMAT.inputSchema),
    eventSchema: z.literal(SUPPORTED_REPLAY_FORMAT.eventSchema),
    replaySchema: z.literal(SUPPORTED_REPLAY_FORMAT.replaySchema),
    profile: z.literal(SUPPORTED_REPLAY_FORMAT.profile),
  }),
});
