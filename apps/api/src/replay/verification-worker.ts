import type { ReplayLocation } from './pack-reader.ts';
import { threadId } from 'node:worker_threads';
import { canonicalJson, ReplayManifestSchema, type ReplayManifest } from '@fantasy/domain/spatial';
import { artifactOperationCode, operationInput, type OperationCode } from '../operation-error.ts';
import { replayValidationProfile, verifyReplayDirectory } from './replay-reader.ts';
import { sha256 } from './replay-files.ts';
import {
  Measurements,
  VERIFICATION_WORKER_STAGE_NAMES,
  type VerificationWorkerStages,
} from '../measurements.ts';
import { assertPublicData, PrivateDataError } from './replay-public.ts';
import { observeGc } from '../jobs/gc-observation.ts';

export type VerificationTask = {
  directory: ReplayLocation;
  manifest: ReplayManifest;
  publicData: boolean;
  measured?: boolean;
};
export type VerificationResponse = {
  success: boolean;
  attempted: boolean;
  manifestHash: string | null;
  validationProfile: string | null;
  stages?: VerificationWorkerStages;
  observation?: Record<string, number>;
  code: OperationCode | 'UNKNOWN';
  /** A publishability failure keeps its classification across the thread boundary. */
  privateData: string | null;
  memory: { heapUsed: number; external: number; arrayBuffers: number };
};

/** Runs the same validator as the in-process path, never a second acceptance implementation. */
export default async function verify(task: VerificationTask): Promise<VerificationResponse> {
  return observeGc(task.measured === true, () => measuredVerification(task));
}
async function measuredVerification(task: VerificationTask): Promise<VerificationResponse> {
  const started = task.measured ? performance.now() : undefined;
  const cpu = task.measured ? process.threadCpuUsage() : undefined;
  const measurement = task.measured ? new Measurements() : undefined;
  const response = await (measurement ? measurement.run(() => verifyTask(task)) : verifyTask(task));
  if (measurement) {
    const stages = measurement.report().stages;
    response.stages = Object.fromEntries(
      VERIFICATION_WORKER_STAGE_NAMES.flatMap((name) =>
        stages[name] ? [[name, stages[name]]] : [],
      ),
    );
  }
  if (cpu && started !== undefined) {
    const used = process.threadCpuUsage(cpu);
    response.observation = {
      threadId,
      elapsedMs: performance.now() - started,
      cpuUserMs: used.user / 1000,
      cpuSystemMs: used.system / 1000,
    };
  }
  return response;
}
async function verifyTask(task: VerificationTask): Promise<VerificationResponse> {
  let success = false,
    attempted = false,
    code: VerificationResponse['code'] = 'UNKNOWN',
    privateData: string | null = null,
    manifestHash: string | null = null,
    validationProfile: string | null = null;
  try {
    const manifest = operationInput(
      () => ReplayManifestSchema.parse(task.manifest),
      'DATA_INVALID',
    );
    attempted = true;
    await verifyReplayDirectory(
      task.directory,
      manifest,
      task.publicData ? assertPublicData : undefined,
    );
    validationProfile = replayValidationProfile(manifest);
    manifestHash = sha256(canonicalJson(manifest));
    success = true;
  } catch (error) {
    code = artifactOperationCode(error);
    if (error instanceof PrivateDataError) privateData = error.message;
  }
  const { heapUsed, external, arrayBuffers } = process.memoryUsage();
  return {
    success,
    attempted,
    manifestHash,
    validationProfile,
    code,
    privateData,
    memory: { heapUsed, external, arrayBuffers },
  };
}
