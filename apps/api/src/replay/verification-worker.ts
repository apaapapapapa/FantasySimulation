import { ReplayManifestSchema, type ReplayManifest } from '@fantasy/domain/spatial';
import { artifactOperationCode, operationInput, type OperationCode } from '../operation-error.ts';
import { verifyReplayDirectory } from './replay-reader.ts';
import { assertPublicData } from './replay-public.ts';

export type VerificationTask = {
  directory: string;
  manifest: ReplayManifest;
  publicData: boolean;
};
export type VerificationResponse = {
  success: boolean;
  attempted: boolean;
  code: OperationCode | 'UNKNOWN';
  memory: { heapUsed: number; external: number; arrayBuffers: number };
};

/** Runs the same validator as the in-process path, never a second acceptance implementation. */
export default async function verify(task: VerificationTask): Promise<VerificationResponse> {
  let success = false,
    attempted = false,
    code: VerificationResponse['code'] = 'UNKNOWN';
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
  }
  const { heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { success, attempted, code, memory: { heapUsed, external, arrayBuffers } };
}
