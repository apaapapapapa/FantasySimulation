import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Measurements } from './measurements.ts';

/** Diagnostics are opt-in sidecars; failure to write them never changes a battle/publication. */
export async function measuredCommand<T>(command: string, work: () => Promise<T>) {
  const directory = process.env.FANTASY_MEASUREMENTS_DIR;
  if (!directory) return work();
  const measurement = new Measurements();
  let status = 'failed';
  const sampling = setInterval(() => measurement.sample(), 1000);
  sampling.unref();
  try {
    const result = await measurement.run(work);
    status = 'completed';
    return result;
  } finally {
    clearInterval(sampling);
    try {
      const report = {
        ...measurement.report(),
        observationId: randomUUID(),
        semantics: {
          wall: 'Independent monotonic process wall. Inclusive stages/Workers/jobs overlap; never sum into wall time.',
          match:
            'Worker dispatch through replay commit/cleanup; later bundle publication and repeated validation are process spans.',
          compute:
            'stream.next includes engine record production; recordingMs is wire serialization; hashMs is stream hashing.',
          memory:
            'Sampled main-isolate heap/external/ArrayBuffer, process RSS, per-Worker peaks/WASM; overlapping categories, not additive.',
          unseparated:
            'Outside coordinator spans includes Worker execution. Nested spans are inclusive; compression/write streaming, domain hashing inside validators, DB callbacks and transient file peaks remain unseparated.',
          coverage:
            'Observed process only. Missing jobs, hard kills, dropped samples, unavailable sidecars and Pages browser acceptance cannot count as zero or success.',
        },
        command,
        status,
        identity: {
          sourceSha: process.env.GITHUB_SHA ?? null,
          runId: process.env.GITHUB_RUN_ID ?? null,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
          job: process.env.GITHUB_JOB ?? null,
          partition: process.env.LEAGUE_PARTITION ?? null,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `measurement-${randomUUID()}.json`),
        JSON.stringify(report) + '\n',
        { flag: 'wx' },
      );
    } catch {
      console.error('Measurement sidecar unavailable; timing evidence is incomplete');
    }
  }
}
