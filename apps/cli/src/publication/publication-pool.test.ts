import { expect, it } from 'vite-plus/test';
import { publicationPool } from './publication-pool.ts';

it('bounds admission and waits for active operations after a failure', async () => {
  const entered: number[] = [],
    finished: number[] = [];
  const gates = Array.from({ length: 4 }, () => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  });
  let settled = false;
  const result = publicationPool([0, 1, 2, 3], 2, async (index) => {
    entered.push(index);
    await gates[index]!.promise;
    finished.push(index);
  }).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  expect(entered).toEqual([0, 1]);
  gates[0]!.reject(new Error('interrupted'));
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(entered).toEqual([0, 1]);
  gates[1]!.resolve();
  expect(await result).toMatchObject({ message: 'interrupted' });
  expect(finished).toEqual([1]);
  expect(entered).toEqual([0, 1]);
});

it.each([0, 17, 1.5, Number.NaN])(
  'refuses concurrency %s before admission',
  async (concurrency) => {
    let calls = 0;
    await expect(
      publicationPool([1], concurrency, async () => {
        calls++;
      }),
    ).rejects.toThrow('concurrency');
    expect(calls).toBe(0);
  },
);
