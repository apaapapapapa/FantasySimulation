import { MAX_RECORD_BYTES } from '@fantasy/domain/spatial';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Piscina } from 'piscina';
import type { Budget } from '@fantasy/domain/spatial';
import type { WorkerResult } from './battle-worker.ts';

export class BattlePool {
  readonly pool: Piscina;
  private startupFailure: Error | null = null;
  constructor(readonly workers = 1) {
    if (
      !Number.isInteger(workers) ||
      workers < 1 ||
      workers > Math.min(4, Math.max(1, availableParallelism() - 1))
    )
      throw new Error('Worker count exceeds the 4-worker/one-reserved-CPU limit');
    const source = import.meta.url.endsWith('.ts');
    this.pool = new Piscina({
      filename: fileURLToPath(
        new URL(source ? './battle-worker.ts' : './battle-worker.mjs', import.meta.url),
      ),
      minThreads: workers,
      maxThreads: workers,
      maxQueue: 0,
      concurrentTasksPerWorker: 1,
      execArgv: source ? ['--import', import.meta.resolve('tsx')] : [],
      resourceLimits: { maxOldGenerationSizeMb: 120, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
      atomics: 'async',
    });
    this.pool.on('error', (error: Error) => {
      this.startupFailure = error;
    });
  }
  async run(
    manifest: unknown,
    budget: Budget,
    accept: (records: unknown[]) => Promise<void>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    if (this.startupFailure) throw this.startupFailure;
    const { port1, port2 } = new MessageChannel();
    let pending = Promise.resolve(),
      receiving = false;
    const controller = new AbortController();
    let failure: unknown;
    port1.on('message', (input: unknown) => {
      if (receiving || !(input instanceof Uint8Array) || input.byteLength > MAX_RECORD_BYTES) {
        failure = new Error('Worker exceeded the one-batch transfer window');
        controller.abort();
        return;
      }
      receiving = true;
      pending = (async () => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
        if (!text.endsWith('\n')) throw new Error('Incomplete worker batch');
        await accept(
          text
            .slice(0, -1)
            .split('\n')
            .map((line): unknown => JSON.parse(line)),
        );
        receiving = false;
        port1.postMessage('accepted');
      })().catch((error: unknown) => {
        failure = error;
        controller.abort();
      });
    });
    try {
      const result: WorkerResult = await this.pool.run(
        { manifest, budget, port: port2 },
        {
          transferList: [port2],
          signal: AbortSignal.any([signal, controller.signal]),
        },
      );
      await pending;
      if (failure) throw failure;
      return result;
    } catch (error) {
      await pending;
      throw failure ?? error;
    } finally {
      port1.close();
      port2.close();
    }
  }
  async close() {
    await this.pool.destroy();
  }
}
