import { GCProfiler } from 'node:v8';

/** Task-local synchronous capture also includes GC in the final synchronous stretch.
 * No observer-flush yields or forced collections are added to measured work.
 * GC elapsed overlaps task wall/CPU; it is not background GC thread CPU.
 */
export async function observeGc<T extends { observation?: Record<string, number> }>(
  enabled: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!enabled) return work();
  const profiler = new GCProfiler();
  profiler.start();
  let stopped = false;
  try {
    const result = await work();
    const { statistics } = profiler.stop();
    stopped = true;
    result.observation = {
      ...result.observation,
      gcCount: statistics.length,
      // Node's native GCProfiler cost is (uv_hrtime delta) / 1e3: microseconds.
      gcDurationMs: statistics.reduce((sum, entry) => sum + entry.cost / 1000, 0),
    };
    return result;
  } finally {
    // Includes initialization failures before the simulation's own try/finally.
    if (!stopped) profiler.stop();
  }
}
