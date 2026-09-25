/** Bound transfer/expansion concurrency, including overlapping seek and log requests. */
export class LoadSlots {
  private active = 0;
  private readonly waiting = new Set<() => void>();
  async run<T>(signal: AbortSignal | undefined, load: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= 2) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          this.waiting.delete(wake);
          signal?.removeEventListener('abort', abort);
          this.active++;
          resolve();
        };
        const abort = () => {
          this.waiting.delete(wake);
          reject(signal!.reason);
        };
        this.waiting.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try {
      signal?.throwIfAborted();
      return await load();
    } finally {
      this.active--;
      this.waiting.values().next().value?.();
    }
  }
}
