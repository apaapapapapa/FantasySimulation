import { z } from 'zod';
import { StoredManifestSchema } from './spatial/contracts.ts';
import { ExecutionSourceSchema } from './spatial/batch.ts';
import { ReplayManifestSchema, RECORDING_PROFILE } from './spatial/replay.ts';

/** Versions understood by both the viewer and the publication preflight. */
export const SUPPORTED_REPLAY_FORMAT = Object.freeze({
  manifestSchema: ReplayManifestSchema.shape.schemaVersion.value,
  inputSchema: 9,
  compatibleInputSchemas: Object.freeze([3, 4, 5, 6, 7, 8, 9] as const),
  eventSchema: StoredManifestSchema.shape.eventSchemaVersion.value,
  replaySchema: StoredManifestSchema.shape.replaySchemaVersion.value,
  profile: RECORDING_PROFILE.id,
});
export const ViewerBuildSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceSha: ExecutionSourceSchema.shape.sha,
  publicationSchema: z.union([z.literal(1), z.literal(2)]),
  replay: z.strictObject({
    manifestSchema: z.literal(SUPPORTED_REPLAY_FORMAT.manifestSchema),
    inputSchema: z.literal(SUPPORTED_REPLAY_FORMAT.inputSchema),
    compatibleInputSchemas: z.tuple([
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
    ]),
    eventSchema: z.literal(SUPPORTED_REPLAY_FORMAT.eventSchema),
    replaySchema: z.literal(SUPPORTED_REPLAY_FORMAT.replaySchema),
    profile: z.literal(SUPPORTED_REPLAY_FORMAT.profile),
  }),
});

export const ReaderBuildSchema = z.strictObject({
  sourceSha: ExecutionSourceSchema.shape.sha,
  publicationSchema: z.literal(2),
});
export type ReaderBuild = z.infer<typeof ReaderBuildSchema>;
