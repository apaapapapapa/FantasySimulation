import { z } from 'zod';
import { canonicalJson } from './canonical.ts';
import {
  HashSchema,
  IdSchema,
  ManifestSchema,
  RefSchema,
  RevisionSchema,
  RulesetSchema,
} from './contracts.ts';
import { encodeNumericState } from './numeric.ts';
import { ResultSchema, type BattleEvent } from './records.ts';
import { DisplayStateSchema, StreamRecordSchema, type StreamRecord } from './stream.ts';

// Display schema support is independent of the installed engine/rules version.
// Old engines are never loaded. A structural format change requires a replay schema bump.
const RecordedRevisionSchema = z.union([
  RevisionSchema,
  z.strictObject({
    kind: z.literal('ruleset'),
    ...RefSchema.shape,
    schemaVersion: z.literal(1),
    definition: RulesetSchema.extend({ rulesVersion: IdSchema }),
  }),
]);
export const RecordedManifestSchema = z.strictObject({
  ...ManifestSchema.shape,
  engineVersion: IdSchema,
  revisions: z.array(RecordedRevisionSchema).min(4).max(256),
});
export type RecordedManifest = z.infer<typeof RecordedManifestSchema>;
export const eventHashLine = (event: BattleEvent): string =>
  `${canonicalJson(encodeNumericState(event))}\n`;
export const trajectoryHashLine = (record: StreamRecord): string => {
  const { events: _, ...display } = 'events' in record ? record : { ...record, events: [] };
  return `${canonicalJson(encodeNumericState(display))}\n`;
};
const step = z.number().int().min(0).max(6000);
const recordIndex = z.number().int().min(0).max(12002);
export const ReplayCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  simulationHash: HashSchema,
  step,
  nextRecord: recordIndex,
  nextEvent: z.number().int().min(0).max(1_000_001),
  boundaryApplied: z.boolean(),
  state: DisplayStateSchema.nullable(),
  lastRecord: StreamRecordSchema.nullable(),
});
export type ReplayCheckpoint = z.infer<typeof ReplayCheckpointSchema>;
export const ArtifactRefSchema = z.strictObject({
  file: z.string().regex(/^(chunk|checkpoint)-[0-9]{5}\.(ndjson|json)\.gz$/),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024),
  rawBytes: z.number().int().min(1).max(4_000_001),
  checksum: HashSchema,
});
export const ReplayChunkSchema = z.strictObject({
  ...ArtifactRefSchema.shape,
  index: recordIndex,
  firstRecord: recordIndex,
  records: z.number().int().min(1).max(12002),
  fromStep: step,
  toStep: step,
  checkpoint: recordIndex,
});
export const ReplayCheckpointRefSchema = z.strictObject({
  ...ArtifactRefSchema.shape,
  index: recordIndex,
  step,
  nextRecord: recordIndex,
});
export const RECORDING_PROFILE = Object.freeze({
  id: 'display-ndjson-gzip-v1' as const,
  codec: 'gzip' as const,
  units: 'metres-binary64' as const,
  stepMs: 20 as const,
  interpolation: 'recorded-piecewise-linear' as const,
  targetChunkBytes: 131072 as const,
  maxCheckpointSteps: 250 as const,
  maxRawBytes: 256_032_768 as const,
  maxStoredBytes: 16_777_216 as const,
});
const ProfileSchema = z.strictObject({
  id: z.literal(RECORDING_PROFILE.id),
  codec: z.literal('gzip'),
  units: z.literal(RECORDING_PROFILE.units),
  stepMs: z.literal(20),
  interpolation: z.literal(RECORDING_PROFILE.interpolation),
  targetChunkBytes: z.literal(131072),
  maxCheckpointSteps: z.literal(250),
  maxRawBytes: z.literal(256_032_768),
  maxStoredBytes: z.literal(16_777_216),
});
export const ReplayEndSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('result'), result: ResultSchema }),
  z.strictObject({ kind: z.enum(['failed', 'cancelled']), reason: z.string().min(1).max(1000) }),
]);
export const ReplayManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    resultId: IdSchema.nullable(),
    attemptId: IdSchema,
    simulationHash: HashSchema,
    input: RecordedManifestSchema,
    profile: ProfileSchema,
    lastVerifiedStep: step.nullable(),
    records: recordIndex,
    eventHash: HashSchema,
    trajectoryHash: HashSchema,
    end: ReplayEndSchema,
    checkpoints: z.array(ReplayCheckpointRefSchema).max(12002),
    chunks: z.array(ReplayChunkSchema).max(12002),
  })
  .superRefine((manifest, ctx) => {
    if ((manifest.end.kind === 'result') !== (manifest.resultId !== null))
      ctx.addIssue({ code: 'custom', message: 'Result ID and terminal kind disagree' });
    if (manifest.end.kind === 'result') {
      const r = manifest.end.result;
      if (
        r.simulationHash !== manifest.simulationHash ||
        r.eventHash !== manifest.eventHash ||
        r.trajectoryHash !== manifest.trajectoryHash ||
        r.steps !== manifest.lastVerifiedStep
      )
        ctx.addIssue({ code: 'custom', message: 'Replay/result binding mismatch' });
    }
    let nextRecord = 0,
      bytes = 0,
      rawBytes = 0,
      previousStep = 0;
    const files = new Set<string>();
    if (manifest.checkpoints.length !== manifest.chunks.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Each chunk requires its own independent checkpoint',
      });
    for (const [i, chunk] of manifest.chunks.entries()) {
      const checkpoint = manifest.checkpoints[i];
      if (
        chunk.index !== i ||
        chunk.firstRecord !== nextRecord ||
        chunk.checkpoint !== i ||
        chunk.fromStep !== previousStep ||
        chunk.toStep < chunk.fromStep ||
        chunk.toStep - chunk.fromStep > manifest.profile.maxCheckpointSteps ||
        !checkpoint ||
        checkpoint.index !== i ||
        checkpoint.nextRecord !== nextRecord ||
        checkpoint.step !== chunk.fromStep ||
        chunk.file !== `chunk-${String(i).padStart(5, '0')}.ndjson.gz` ||
        checkpoint.file !== `checkpoint-${String(i).padStart(5, '0')}.json.gz`
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid chunk/checkpoint index' });
      nextRecord += chunk.records;
      previousStep = chunk.toStep;
    }
    for (const ref of [...manifest.chunks, ...manifest.checkpoints]) {
      bytes += ref.bytes;
      rawBytes += ref.rawBytes;
      if (files.has(ref.file)) ctx.addIssue({ code: 'custom', message: 'Duplicate artifact path' });
      files.add(ref.file);
    }
    if (
      bytes > RECORDING_PROFILE.maxStoredBytes ||
      rawBytes > RECORDING_PROFILE.maxRawBytes ||
      nextRecord !== manifest.records ||
      (nextRecord === 0
        ? manifest.lastVerifiedStep !== null
        : previousStep !== manifest.lastVerifiedStep)
    )
      ctx.addIssue({ code: 'custom', message: 'Replay range or size limit mismatch' });
  });
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
