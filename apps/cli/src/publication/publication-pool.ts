export function publicationConcurrency(value = 1) {
  if (!Number.isInteger(value) || value < 1 || value > 16)
    throw new Error('Invalid publication concurrency');
  return value;
}

/** Stop admission on failure and await every admitted operation before returning. */
export async function publicationPool<T>(
  items: readonly T[],
  concurrency: number,
  perform: (item: T) => Promise<void>,
) {
  publicationConcurrency(concurrency);
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (!failures.length && next < items.length) {
        const item = items[next++]!;
        try {
          await perform(item);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw failures[0];
}
