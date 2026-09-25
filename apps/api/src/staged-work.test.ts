import { expect, it } from 'vite-plus/test';
import { stagedWork } from './staged-work.ts';

it('streams 297,000 league inputs in order with a four-item admission window', async () => {
  let pulled = 0,
    received = 0,
    peak = 0;
  function* inputs() {
    for (let id = 0; id < 297_000; id++) {
      pulled++;
      peak = Math.max(peak, pulled - received);
      yield id;
    }
  }
  for await (const id of stagedWork(inputs(), 4, async (id) => id)) {
    if (id !== received) throw new Error(`Out-of-order result at ${received}: ${id}`);
    received++;
  }
  expect(received).toBe(297_000);
  expect(peak).toBe(4);
});
it('stops admission on consumer close and waits for aborted in-flight cleanup', async () => {
  let pulled = 0,
    cleaned = 0,
    closed = false;
  function* inputs() {
    try {
      for (let id = 0; id < 100; id++) {
        pulled++;
        yield id;
      }
    } finally {
      closed = true;
    }
  }
  const stream = stagedWork(inputs(), 4, async (id, signal) => {
    if (id)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    cleaned++;
    return id;
  });
  expect((await stream.next()).value).toBe(0);
  expect(pulled).toBe(4);
  await stream.return(undefined);
  expect(cleaned).toBe(4);
  expect(closed).toBe(true);
});
it('drains work after a source failure and propagates worker rejection without unhandled promises', async () => {
  let stopped = false;
  async function* broken() {
    yield 0;
    throw new Error('Source unavailable');
  }
  const source = stagedWork(broken(), 4, async (_, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    stopped = true;
  });
  await expect(source.next()).rejects.toThrow('Source unavailable');
  expect(stopped).toBe(true);
  const failure = stagedWork([1, 2], 2, async () => {
    throw new Error('Work failed');
  });
  await expect(failure.next()).rejects.toThrow('Work failed');
});
it('does not read an aborted source and rejects invalid admission bounds', async () => {
  let pulled = false;
  function* inputs() {
    pulled = true;
    yield 0;
  }
  const aborted = stagedWork(inputs(), 1, async (id) => id, AbortSignal.abort());
  expect((await aborted.next()).done).toBe(true);
  expect(pulled).toBe(false);
  for (const invalid of [0, 5, 1.5, NaN])
    await expect(stagedWork([], invalid, async () => 0).next()).rejects.toThrow('Invalid staged');
});
