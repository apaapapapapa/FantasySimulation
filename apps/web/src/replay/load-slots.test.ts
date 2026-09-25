import { expect, it } from 'vite-plus/test';
import { LoadSlots } from './load-slots.ts';

it('bounds overlapping loads and releases slots after failure and cancellation', async () => {
  const slots = new LoadSlots(),
    releases: (() => void)[] = [],
    started: number[] = [];
  const load = (id: number, signal?: AbortSignal) =>
    slots.run(signal, async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      if (id === 1) throw new Error('broken file');
      return id;
    });
  const first = load(1),
    second = load(2),
    controller = new AbortController();
  const cancelled = load(3, controller.signal),
    fourth = load(4);
  expect(started).toEqual([1, 2]);
  controller.abort();
  await expect(cancelled).rejects.toThrow();
  releases.shift()!();
  await expect(first).rejects.toThrow('broken file');
  expect(started).toEqual([1, 2, 4]);
  releases.splice(0).forEach((release) => release());
  expect(await Promise.all([second, fourth])).toEqual([2, 4]);
  await expect(load(5, AbortSignal.abort())).rejects.toThrow();
  expect(started).not.toContain(5);
});
