import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';
import { statSync } from 'node:fs';

type Stage = {
  count: number;
  failures: number;
  bytes: number;
  inclusiveMs: number;
  busyMs: number;
  active: number;
  changedAt: number;
};
export type MatchMeasurement = {
  simulationHash: string;
  attemptId: string;
  scenario: string;
  participants: string[];
  outcome: string;
  wallMs: number;
  storedBytes?: number;
  worker?: Record<string, number | boolean>;
};
const context = new AsyncLocalStorage<Measurements>();
const limit = 20000;

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return {
    count: n,
    median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p95: n ? sorted[Math.ceil(n * 0.95) - 1]! : null,
    max: n ? sorted[n - 1]! : null,
  };
}

/** Process-local monotonic clocks. Inclusive work and union wall time are different quantities. */
export class Measurements {
  private readonly started = performance.now();
  private readonly startedAt = new Date().toISOString();
  private readonly cpu = process.cpuUsage();
  private readonly stages = new Map<string, Stage>();
  private readonly matches: MatchMeasurement[] = [];
  private readonly validations = new Map<string, { calls: number; failures: number }>();
  private readonly capacities: Record<string, number> = {};
  private readonly queues: Record<
    string,
    { admitted: number; totalWaitMs: number; maxWaitMs: number; maxPending: number }
  > = {};
  private readonly peaks = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  private active = 0;
  private changedAt = this.started;
  private coveredMs = 0;
  private dropped = 0;
  run<T>(work: () => T): T {
    return context.run(this, work);
  }
  sample() {
    const memory = process.memoryUsage();
    for (const key of Object.keys(this.peaks) as (keyof typeof this.peaks)[])
      this.peaks[key] = Math.max(this.peaks[key], memory[key]);
  }
  start(name: string, now = performance.now()) {
    let stage = this.stages.get(name);
    if (!stage) {
      stage = {
        count: 0,
        failures: 0,
        bytes: 0,
        inclusiveMs: 0,
        busyMs: 0,
        active: 0,
        changedAt: now,
      };
      this.stages.set(name, stage);
    }
    if (this.active) this.coveredMs += now - this.changedAt;
    this.changedAt = now;
    this.active++;
    if (stage.active) stage.busyMs += now - stage.changedAt;
    stage.changedAt = now;
    stage.active++;
    let ended = false;
    return (success = true, bytes = 0, end = performance.now()) => {
      if (ended) return;
      ended = true;
      stage.count++;
      stage.failures += success ? 0 : 1;
      stage.bytes += bytes;
      stage.inclusiveMs += end - now;
      stage.busyMs += end - stage.changedAt;
      stage.changedAt = end;
      stage.active--;
      this.coveredMs += end - this.changedAt;
      this.changedAt = end;
      this.active--;
    };
  }
  match(value: MatchMeasurement) {
    if (this.matches.length < limit) this.matches.push(value);
    else this.dropped++;
    this.sample();
  }
  validation(id: string, success: boolean) {
    if (!this.validations.has(id) && this.validations.size >= limit) {
      this.dropped++;
      return;
    }
    const count = this.validations.get(id) ?? { calls: 0, failures: 0 };
    count.calls++;
    count.failures += success ? 0 : 1;
    this.validations.set(id, count);
  }
  capacity(name: string, bytes: number) {
    this.capacities[name] = Math.max(this.capacities[name] ?? 0, bytes);
  }
  addBytes(name: string, bytes: number) {
    const stage = this.stages.get(name);
    if (stage) stage.bytes += bytes;
  }
  queue(name: string, waitMs: number, pending: number) {
    const value = (this.queues[name] ??= {
      admitted: 0,
      totalWaitMs: 0,
      maxWaitMs: 0,
      maxPending: 0,
    });
    value.admitted++;
    value.totalWaitMs += waitMs;
    value.maxWaitMs = Math.max(value.maxWaitMs, waitMs);
    value.maxPending = Math.max(value.maxPending, pending);
  }
  report() {
    this.sample();
    const now = performance.now(),
      wallMs = now - this.started,
      cpu = process.cpuUsage(this.cpu);
    const measuredSpanUnionMs = this.coveredMs + (this.active ? now - this.changedAt : 0);
    const calls = [...this.validations.values()].reduce((n, v) => n + v.calls, 0);
    return {
      schemaVersion: 1,
      startedAt: this.startedAt,
      observedAt: new Date().toISOString(),
      wallMs,
      measuredSpanUnionMs,
      unseparatedMs: Math.max(0, wallMs - measuredSpanUnionMs),
      incompleteSpans: this.active,
      droppedRecords: this.dropped,
      cpu: {
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        oneCorePercent: wallMs ? (cpu.user + cpu.system) / (wallMs * 10) : null,
        availableParallelism: availableParallelism(),
        scope: 'process including all Workers; do not add thread CPU',
      },
      memory: {
        sampledPeakBytes: this.peaks,
        processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      },
      capacitySampleMaxBytes: this.capacities,
      queues: this.queues,
      stages: Object.fromEntries(
        [...this.stages].map(([name, s]) => [
          name,
          {
            count: s.count,
            failures: s.failures,
            bytes: s.bytes,
            inclusiveMs: s.inclusiveMs,
            busyWallMs: s.busyMs + (s.active ? now - s.changedAt : 0),
            incomplete: s.active,
          },
        ]),
      ),
      matchWallMs: distribution(this.matches.map((m) => m.wallMs)),
      workerMetrics: Object.fromEntries(
        [...new Set(this.matches.flatMap((m) => Object.keys(m.worker ?? {})))]
          .filter((k) => k !== 'threadId' && k !== 'cold')
          .map((key) => [
            key,
            distribution(
              this.matches.flatMap((m) =>
                typeof m.worker?.[key] === 'number' ? [m.worker[key]] : [],
              ),
            ),
          ]),
      ),
      matches: this.matches,
      validation: {
        calls,
        uniqueReplays: this.validations.size,
        repeatedCalls: calls - this.validations.size,
        repeatedFraction: calls ? (calls - this.validations.size) / calls : null,
        replays: Object.fromEntries(this.validations),
      },
    };
  }
}

export const currentMeasurements = () => context.getStore();
const noop = () => {};
export const startMeasurement = (name: string) => context.getStore()?.start(name) ?? noop;
export function measureSync<T>(name: string, work: () => T): T {
  const end = startMeasurement(name);
  try {
    const value = work();
    end();
    return value;
  } catch (error) {
    end(false);
    throw error;
  }
}
export async function measureAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
  const end = startMeasurement(name);
  try {
    const value = await work();
    end();
    return value;
  } catch (error) {
    end(false);
    throw error;
  }
}
/** Bounded metadata probes, never scan the replay tree on the measured path. */
export function sampleDatabase(path: string) {
  const measurement = currentMeasurements();
  if (!measurement) return;
  for (const [name, suffix] of [
    ['db', ''],
    ['wal', '-wal'],
    ['shm', '-shm'],
  ] as const) {
    try {
      measurement.capacity(name, statSync(path + suffix).size);
    } catch {
      /* Missing/transient files are not an observed zero. */
    }
  }
}
