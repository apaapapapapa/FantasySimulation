import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { threadId, type MessagePort } from 'node:worker_threads';
import {
  canonicalJson,
  eventHashLine,
  trajectoryHashLine,
  type BattleResult,
  type Budget,
} from '@fantasy/domain/spatial';
import {
  finalizeBattleResult,
  initializePhysics,
  prepareBattle,
  simulate,
} from '@fantasy/engine/spatial';
import { measureWasmInitialization } from './wasm-metrics.ts';

export type WorkerTask = { manifest: unknown; budget: Budget; port: MessagePort };
export type WorkerMetrics = {
  threadId: number;
  cold: boolean;
  elapsedMs: number;
  initializationMs: number;
  computeMs: number;
  backpressureMs: number;
  transferBytes: number;
  peakBatchBytes: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  wasmLinearBytes: number;
};
export type WorkerResult = { result: BattleResult; metrics: WorkerMetrics };
let initialized = false;
let wasmBytes: (() => number) | undefined;

/** Pull one bounded batch, transfer it, and wait for durable-writer acceptance before continuing. */
export default async function battleWorker(task: WorkerTask): Promise<WorkerResult> {
  const started = performance.now(),
    cold = !initialized;
  wasmBytes ??= await measureWasmInitialization(initializePhysics);
  const battle = await prepareBattle(task.manifest);
  initialized = true;
  const initializationMs = performance.now() - started;
  const events = createHash('sha256'),
    trajectory = createHash('sha256');
  const stream = simulate(battle, task.budget);
  let lines: string[] = [],
    bytes = 0,
    transferBytes = 0,
    peakBatchBytes = 0;
  let computeMs = 0,
    backpressureMs = 0;
  let heapUsed = 0,
    external = 0,
    arrayBuffers = 0;
  function sampleMemory() {
    const memory = process.memoryUsage();
    heapUsed = Math.max(heapUsed, memory.heapUsed);
    external = Math.max(external, memory.external);
    arrayBuffers = Math.max(arrayBuffers, memory.arrayBuffers);
  }
  async function flush() {
    if (!bytes) return;
    const buffer = new TextEncoder().encode(lines.join(''));
    peakBatchBytes = Math.max(peakBatchBytes, buffer.byteLength);
    transferBytes += buffer.byteLength;
    lines = [];
    bytes = 0;
    sampleMemory();
    const waiting = performance.now();
    const accepted = once(task.port, 'message');
    task.port.postMessage(buffer, [buffer.buffer]);
    const [reply] = await accepted;
    if (reply !== 'accepted') throw new Error('Coordinator rejected stream');
    backpressureMs += performance.now() - waiting;
  }
  try {
    for (;;) {
      const calculating = performance.now();
      const next = stream.next();
      computeMs += performance.now() - calculating;
      if (next.done) {
        await flush();
        const end = next.value;
        const result = await finalizeBattleResult(battle.simulationHash, end, {
          eventHash: `sha256:${events.digest('hex')}`,
          trajectoryHash: `sha256:${trajectory.digest('hex')}`,
        });
        sampleMemory();
        return {
          result,
          metrics: {
            threadId,
            cold,
            elapsedMs: performance.now() - started,
            initializationMs,
            computeMs,
            backpressureMs,
            transferBytes,
            peakBatchBytes,
            heapUsed,
            external,
            arrayBuffers,
            wasmLinearBytes: wasmBytes(),
          },
        };
      }
      const record = next.value,
        line = canonicalJson(record) + '\n';
      const size = Buffer.byteLength(line);
      if (size > 4_000_001) throw new Error('Worker record exceeds transfer limit');
      if (bytes + size > 131072) await flush();
      if ('events' in record)
        for (const event of record.events) events.update(eventHashLine(event));
      trajectory.update(trajectoryHashLine(record));
      lines.push(line);
      bytes += size;
      if (bytes >= 131072) await flush();
    }
  } finally {
    stream.return(undefined as never);
    task.port.close();
  }
}
