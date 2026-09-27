import { expect, it } from 'vite-plus/test';
import { PublicationIo } from './publication-io.ts';

function block(queue: PublicationIo, bytes: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, result: queue.run(bytes, () => gate) };
}

it('uses free payload capacity behind a blocked head without reordering returned results', async () => {
  const queue = new PublicationIo(3, 10);
  const held = block(queue, 8);
  const started: string[] = [];
  const large = queue.run(9, async () => {
    started.push('large');
    return 9;
  });
  const small = queue.run(2, async () => {
    started.push('small');
    return 2;
  });
  const settled = Promise.allSettled([held.result, large, small]);
  try {
    expect(await small).toBe(2);
    expect(started).toEqual(['small']);
    held.release();
    expect(await Promise.all([large, small])).toEqual([9, 2]);
    expect(started).toEqual(['small', 'large']);
  } finally {
    held.release();
    await settled;
    await queue.close();
  }
});

it('stops overtaking after eight admissions so a large transfer cannot starve', async () => {
  const queue = new PublicationIo(64, 10);
  const held = block(queue, 9);
  const started: number[] = [];
  const large = queue.run(10, async () => {
    started.push(-1);
  });
  const small = Array.from({ length: 12 }, (_, i) =>
    queue.run(1, async () => {
      started.push(i);
    }),
  );
  const settled = Promise.allSettled([held.result, large, ...small]);
  try {
    await Promise.all(small.slice(0, 8));
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    held.release();
    await settled;
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, -1, 8, 9, 10, 11]);
  } finally {
    held.release();
    await settled;
    await queue.close();
  }
});

it('cancels a bypassed queue and drains admitted work before closing', async () => {
  const controller = new AbortController();
  const queue = new PublicationIo(3, 10, controller.signal);
  const held = block(queue, 8);
  let ranLarge = false;
  const large = queue.run(9, async () => {
    ranLarge = true;
  });
  const small = block(queue, 2);
  const settled = Promise.allSettled([held.result, large, small.result]);
  controller.abort(new Error('cancel fair-fit transfers'));
  let closed = false;
  const closing = queue.close().then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    expect(closed).toBe(false);
    held.release();
    small.release();
    await closing;
    expect(ranLarge).toBe(false);
    expect((await settled).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
  } finally {
    held.release();
    small.release();
    await settled;
    await closing;
  }
});
