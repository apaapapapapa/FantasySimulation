import { expect, it } from 'vite-plus/test';
import { PublicationIo, transferTuning } from './publication-io.ts';

it.each([16, 32, 64])(
  'bounds active transfers at %s while preserving all results',
  async (width) => {
    const queue = new PublicationIo(width, 128);
    let active = 0,
      peak = 0;
    try {
      const values = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          queue.run(2, async () => {
            peak = Math.max(peak, ++active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active--;
            return i;
          }),
        ),
      );
      expect(values).toEqual(Array.from({ length: 80 }, (_, i) => i));
      expect(peak).toBe(width);
      expect(active).toBe(0);
    } finally {
      await queue.close();
    }
  },
);

it('bounds payload bytes independently of request concurrency', async () => {
  const queue = new PublicationIo(64, 10);
  let active = 0,
    peak = 0;
  try {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        queue.run(4, async () => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  } finally {
    await queue.close();
  }
});

it.each(['failure', 'abort'] as const)(
  'stops queued work and drains active work on %s',
  async (kind) => {
    const controller = new AbortController();
    const queue = new PublicationIo(2, 10, controller.signal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: number[] = [];
    let finished = false;
    const tasks = [0, 1, 2, 3].map((i) =>
      queue.run(4, async () => {
        entered.push(i);
        if (i === 0) {
          await Promise.resolve();
          if (kind === 'abort') controller.abort(new Error('aborted'));
          else throw new Error('failed');
        } else {
          await gate;
          finished = true;
        }
      }),
    );
    const results = Promise.allSettled(tasks);
    await Promise.resolve();
    await Promise.resolve();
    let drained = false;
    const closed = queue.close().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    expect(entered).toEqual([0, 1]);
    release();
    await closed;
    expect(finished).toBe(true);
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    await expect(queue.run(1, async () => 1)).rejects.toThrow();
  },
);

it.each([
  { readConcurrency: 65 },
  { writeConcurrency: 0 },
  { headConcurrency: 1.5 },
  { maxInFlightBytes: 0 },
  { maxInFlightBytes: 257 * 1024 ** 2 },
])('rejects invalid transfer tuning before admission: %j', (input) => {
  expect(() => transferTuning(input)).toThrow();
});
