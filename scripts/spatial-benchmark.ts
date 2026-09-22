import { createHash } from 'node:crypto';
import { availableParallelism, cpus, platform, arch, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { initializePhysics } from '../packages/engine/src/spatial/physics.ts';
import { probeInputs, runProbe } from '../packages/engine/src/spatial/probe.ts';
import identity from '../packages/engine/src/spatial/implementation.json' with { type: 'json' };

const before = performance.now();
await initializePhysics();
const initializeMs = performance.now() - before;
const samples = Number(process.env.BENCH_SAMPLES ?? 20);
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 100)
  throw new Error('BENCH_SAMPLES must be 2..100');
const rows = [];
for (const input of probeInputs) {
  const runs = [];
  for (let index = 0; index <= samples; index++) {
    const start = performance.now();
    const result = runProbe(input);
    const computed = performance.now();
    const hash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    runs.push({
      computeMs: computed - start,
      hashMs: performance.now() - computed,
      hash,
      ...process.memoryUsage(),
      steps: result.steps,
      casts: result.casts,
    });
  }
  const sorted = runs
    .slice(1)
    .map((r) => r.computeMs)
    .sort((a, b) => a - b);
  const totalMs = sorted.reduce((sum, time) => sum + time, 0);
  rows.push({
    input,
    cold: runs[0],
    warmMedianMs: sorted[Math.floor(samples / 2)],
    warmP95Ms: sorted[Math.ceil(samples * 0.95) - 1],
    batchMs: totalMs,
    matchesPerSecond: (samples * 1000) / totalMs,
    samples: runs.slice(1),
  });
}
console.log(
  JSON.stringify(
    {
      environment: {
        cpu: cpus()[0]?.model,
        cores: availableParallelism(),
        ram: totalmem(),
        platform: platform(),
        arch: arch(),
        node: process.version,
      },
      identity,
      initializeMs,
      workers: 1,
      cache: false,
      measurements:
        'compute includes TS, Rapier, boundary transfers, geometry checkpoints and snapshot; these costs are not separately instrumented. Hash is separate. No DB, compression or formal replay logs.',
      rows,
    },
    null,
    2,
  ),
);
