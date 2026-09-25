// Ordered, bounded admission with consumer backpressure. Never materialize the source.
export async function* stagedWork<T, R>(
  source: AsyncIterable<T> | Iterable<T>,
  concurrency: number,
  work: (input: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): AsyncGenerator<R> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error('Invalid staged concurrency');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const iterator =
    Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  const pending: Promise<{ value: R } | { error: unknown }>[] = [];
  let ended = false;
  const fill = async () => {
    while (!ended && !controller.signal.aborted && pending.length < concurrency) {
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        break;
      }
      if (controller.signal.aborted) break;
      pending.push(
        Promise.resolve()
          .then(() => work(next.value, controller.signal))
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          ),
      );
    }
  };
  try {
    await fill();
    while (pending.length) {
      const outcome = await pending.shift()!;
      if ('error' in outcome) throw outcome.error;
      yield outcome.value;
      await fill();
    }
  } finally {
    controller.abort(new Error('Staged consumer closed'));
    signal?.removeEventListener('abort', abort);
    try {
      await iterator.return?.();
    } finally {
      await Promise.allSettled(pending);
    }
  }
}
