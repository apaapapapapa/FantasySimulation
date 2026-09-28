import type { ReplayLocation } from './pack-reader.ts';
import { ReplayManifestSchema, type ReplayManifest } from '@fantasy/domain/spatial';
import { artifactOperationCode, operationInput, type OperationCode } from '../operation-error.ts';
import { verifyReplayDirectory } from './replay-reader.ts';
import { assertPublicData, PrivateDataError } from './replay-public.ts';

export type VerificationTask = {
  directory: ReplayLocation;
  manifest: ReplayManifest;
  publicData: boolean;
};
export type VerificationResponse = {
  success: boolean;
  attempted: boolean;
  code: OperationCode | 'UNKNOWN';
  /** A publishability failure keeps its classification across the thread boundary. */
  privateData: string | null;
  memory: { heapUsed: number; external: number; arrayBuffers: number };
};

/** Runs the same validator as the in-process path, never a second acceptance implementation. */
export default async function verify(task: VerificationTask): Promise<VerificationResponse> {
  let success = false,
    attempted = false,
    code: VerificationResponse['code'] = 'UNKNOWN',
    privateData: string | null = null;
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
    success = true;
  } catch (error) {
    code = artifactOperationCode(error);
    if (error instanceof PrivateDataError) privateData = error.message;
  }
  const { heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { success, attempted, code, privateData, memory: { heapUsed, external, arrayBuffers } };
}
