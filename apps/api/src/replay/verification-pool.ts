import type { ReplayLocation } from './pack-reader.ts';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Piscina } from 'piscina';
import type { ReplayManifest } from '@fantasy/domain/spatial';
import { currentMeasurements, startMeasurement, type VerificationStage } from '../measurements.ts';
import { OperationError } from '../operation-error.ts';
import { PrivateDataError } from './replay-public.ts';
import type { VerificationResponse, VerificationTask } from './verification-worker.ts';

export type ReplayVerifier = {
  readonly workers: number;
  readonly signal?: AbortSignal | undefined;
  verify(directory: ReplayLocation, manifest: ReplayManifest, publicData: boolean): Promise<void>;
};

/** Both standalone and producer pools use the same response/error accounting. */
export async function verifyInWorker(
  run: (task: VerificationTask) => Promise<VerificationResponse>,
  directory: ReplayLocation,
  manifest: ReplayManifest,
  publicData: boolean,
  stage: VerificationStage = 'validate.replay.worker',
) {
  const measured = currentMeasurements(),
    end = startMeasurement(stage);
  let succeeded = false;
  try {
    const result = await run({ directory, manifest, publicData, measured: measured !== undefined });
    if (result.stages) measured?.verificationStages(result.stages);
    if (result.observation)
      measured?.verificationObservation({
        replayId: manifest.id,
        stage,
        success: result.success,
        attempted: result.attempted,
        observation: result.observation,
      });
    if (result.attempted) measured?.validation(manifest.id, result.success);
    for (const [name, bytes] of Object.entries(result.memory))
      measured?.capacity(`verification.worker.${name}`, bytes);
    if (!result.success) {
      if (result.privateData !== null) throw new PrivateDataError(result.privateData);
      if (result.code !== 'UNKNOWN')
        throw new OperationError(result.code, 'Replay Worker validation failed');
      throw new Error('Replay Worker verification failed');
    }
    succeeded = true;
  } finally {
    end(succeeded);
  }
}

export function replayVerificationWorkers(requested = 1) {
  if (!Number.isInteger(requested) || requested < 1 || requested > 4)
    throw new OperationError('INPUT_INVALID', 'Expected one to four replay verification Workers');
  return Math.min(requested, Math.max(1, availableParallelism() - 1));
}

/** Bounded CPU work; callers drain each admitted batch before closing the pool. */
export class ReplayVerificationPool {
  readonly pool: Piscina;
  readonly workers: number;
  private startupFailure: Error | undefined;
  private closed = false;
  constructor(
    workers = 2,
    readonly signal?: AbortSignal,
  ) {
    this.workers = replayVerificationWorkers(workers);
    const source = import.meta.url.endsWith('.ts');
    this.pool = new Piscina({
      filename: fileURLToPath(
        new URL(source ? './verification-worker.ts' : './verification-worker.mjs', import.meta.url),
      ),
      minThreads: this.workers,
      maxThreads: this.workers,
      maxQueue: 0,
      concurrentTasksPerWorker: 1,
      env: {},
      execArgv: source ? ['--import', import.meta.resolve('tsx')] : [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      atomics: 'async',
    });
    this.pool.on('error', (error: Error) => {
      this.startupFailure = error;
    });
  }
  async verify(directory: ReplayLocation, manifest: ReplayManifest, publicData: boolean) {
    if (this.closed) throw new Error('Replay verification pool is closed');
    if (this.startupFailure) throw this.startupFailure;
    this.signal?.throwIfAborted();
    await verifyInWorker(
      async (task) => {
        const result: VerificationResponse = await this.pool.run(
          task,
          this.signal ? { signal: this.signal } : undefined,
        );
        if (this.closed) throw new Error('Replay verification pool is closed');
        this.signal?.throwIfAborted();
        return result;
      },
      directory,
      manifest,
      publicData,
    );
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.destroy();
  }
}

export async function withReplayVerificationPool<T>(
  requested: number,
  work: (pool: ReplayVerificationPool | undefined) => Promise<T>,
  signal?: AbortSignal,
) {
  const workers = replayVerificationWorkers(requested);
  signal?.throwIfAborted();
  const pool = workers > 1 ? new ReplayVerificationPool(workers, signal) : undefined;
  try {
    return await work(pool);
  } finally {
    await pool?.close();
  }
}
