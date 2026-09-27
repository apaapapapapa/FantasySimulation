import { currentMeasurements, OperationError } from '@fantasy/api/artifacts';
import { publicationConcurrency } from './publication-pool.ts';

export const DEFAULT_TRANSFER_BYTES = 64 * 1024 ** 2;
export interface TransferTuning {
  readConcurrency?: number;
  writeConcurrency?: number;
  headConcurrency?: number;
  maxInFlightBytes?: number;
}
export function transferTuning(input: TransferTuning = {}, fallback = 16) {
  const read = publicationConcurrency(input.readConcurrency ?? fallback, 64);
  const write = publicationConcurrency(input.writeConcurrency ?? fallback, 64);
  const head = publicationConcurrency(input.headConcurrency ?? fallback, 64);
  const bytes = input.maxInFlightBytes ?? DEFAULT_TRANSFER_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 ** 2 || bytes > 256 * 1024 ** 2)
    throw new OperationError('INPUT_INVALID', 'Invalid transfer in-flight byte limit');
  return { read, write, head, bytes, sockets: Math.max(read, write, head) };
}

type Pending = {
  bytes: number;
  bypasses: number;
  start(): Promise<void>;
  reject(error: unknown): void;
};
/** One payload budget across nested graph tasks. No response buffers are retained in the queue. */
export class PublicationIo {
  private readonly pending: Pending[] = [];
  private active = 0;
  private bytes = 0;
  private stopped = false;
  private failure: unknown;
  private readonly idle: (() => void)[] = [];
  private readonly abort = () => this.stop(this.signal?.reason);
  constructor(
    readonly concurrency: number,
    readonly maxBytes = DEFAULT_TRANSFER_BYTES,
    private readonly signal?: AbortSignal,
  ) {
    publicationConcurrency(concurrency, 64);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 ** 2)
      throw new OperationError('INPUT_INVALID', 'Invalid transfer in-flight byte limit');
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  run<T>(bytes: number, work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(this.failure);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes)
      return Promise.reject(new OperationError('BUDGET_EXCEEDED', 'Transfer payload limit'));
    if (this.pending.length >= 4096)
      return Promise.reject(new OperationError('BUDGET_EXCEEDED', 'Transfer queue limit'));
    const queuedAt = performance.now();
    const measurement = currentMeasurements();
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        bytes,
        bypasses: 0,
        reject,
        start: async () => {
          try {
            measurement?.queue('r2.io', performance.now() - queuedAt, this.pending.length);
            measurement?.capacity('transfer.inFlightBytes', this.bytes);
            const value = await work();
            if (this.stopped) throw this.failure;
            resolve(value);
          } catch (error) {
            this.stop(error);
            reject(error);
          }
        },
      });
      this.pump();
    });
  }
  /** At most 64 candidates and eight overtakes per task; then drain for that task. */
  private next() {
    for (let index = 0; index < Math.min(this.pending.length, 64); index++) {
      const task = this.pending[index]!;
      if (this.bytes + task.bytes <= this.maxBytes) return index;
      if (task.bypasses >= 8) break;
    }
    return -1;
  }
  private pump() {
    while (!this.stopped && this.active < this.concurrency && this.pending.length) {
      const index = this.next();
      if (index < 0) break;
      for (let skipped = 0; skipped < index; skipped++) this.pending[skipped]!.bypasses++;
      const [task] = this.pending.splice(index, 1);
      this.active++;
      this.bytes += task!.bytes;
      void task!.start().finally(() => {
        this.active--;
        this.bytes -= task!.bytes;
        this.pump();
        if (!this.active && !this.pending.length) this.idle.splice(0).forEach((done) => done());
      });
    }
  }
  stop(error: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    this.failure = error;
    this.pending.splice(0).forEach((task) => task.reject(error));
  }
  async close(error: unknown = new Error('Transfer queue is closed')) {
    this.stop(error);
    if (this.active) await new Promise<void>((resolve) => this.idle.push(resolve));
    this.signal?.removeEventListener('abort', this.abort);
  }
}
