import { z } from 'zod';
import { ExecutionSourceSchema } from '../batch.ts';
import { HashSchema, IdSchema } from '../contracts.ts';
import { PublicKeySchema, PublicReplayRefSchema } from '../publication.ts';
import { BundleReceiptSchema } from '../batch.ts';
import { ReplayManifestSchema } from '../replay.ts';

export const LeaguePipelineIdentitySchema = z.strictObject({
  source: ExecutionSourceSchema,
  runId: z.number().int().positive().safe(),
  runAttempt: z.number().int().positive().safe(),
  validatorDigest: HashSchema,
});
export const LeaguePipelineControlSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: LeaguePipelineIdentitySchema,
  runners: z.number().int().min(1).max(32),
  ciRunId: z.number().int().positive().safe(),
  catalogHash: HashSchema,
  admissionWrites: z.number().int().min(1).max(1000),
});
export const LeaguePipelineFileSchema = z.strictObject({
  key: PublicKeySchema,
  bytes: z.number().int().min(1).max(8000000000),
  checksum: HashSchema,
});
export const LeagueReplayProofSchema = z.strictObject({
  ref: PublicReplayRefSchema,
  receipt: BundleReceiptSchema,
  manifest: ReplayManifestSchema,
  physical: z.array(LeaguePipelineFileSchema).max(500000),
  logical: z.array(LeaguePipelineFileSchema).max(500000),
});
export const LeagueEvidenceCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: LeaguePipelineIdentitySchema,
  catalogHash: HashSchema,
  auditedAt: z.string().datetime(),
  metadata: z
    .array(z.strictObject({ file: LeaguePipelineFileSchema, json: z.string().max(16000000) }))
    .max(500000),
  replays: z.array(LeagueReplayProofSchema).max(20000),
  md5: z.array(z.tuple([PublicKeySchema, z.string().regex(/^[a-f0-9]{32}$/)])).max(500000),
});
export const LeagueProducerProofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: LeaguePipelineIdentitySchema,
  runner: z.number().int().min(0).max(31),
  partition: z.number().int().min(0).max(63),
  planId: HashSchema,
  partitionId: HashSchema,
  inputHash: HashSchema,
  resultHash: HashSchema,
  setHash: HashSchema,
  files: z.array(LeaguePipelineFileSchema).min(1).max(4096),
});
export const LeagueProducerArtifactSchema = z.strictObject({
  id: z.number().int().positive().safe(),
  digest: HashSchema,
  name: z.string().regex(/^league-[a-zA-Z0-9-]+$/),
  bytes: z.number().int().min(1).max(67108864),
});
export const LeagueProducerTerminalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: LeaguePipelineIdentitySchema,
  runner: z.number().int().min(0).max(31),
  partitions: z.array(z.number().int().min(0).max(63)).min(1).max(64),
  artifacts: z.array(LeagueProducerArtifactSchema).min(1).max(30),
});
export const LeagueCheckpointLocatorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogHash: HashSchema,
  identity: LeaguePipelineIdentitySchema,
  writerRun: z.number().int().positive().safe(),
  writerAttempt: z.number().int().positive().safe(),
  artifactId: z.number().int().positive().safe(),
  archiveHash: HashSchema,
  archiveBytes: z.number().int().min(1).max(67108864),
});

export const LeagueCostProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: ExecutionSourceSchema,
  measurementHash: HashSchema,
  metric: z.literal('worker-compute-elapsed-ms'),
  samples: z
    .array(
      z.strictObject({
        simulationHash: HashSchema,
        scenario: IdSchema,
        characters: z.tuple([IdSchema, IdSchema]),
        elapsedMs: z.number().min(0).max(1800000),
      }),
    )
    .min(1)
    .max(20000),
});
