import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution } from '@fantasy/api/tooling';
import { readBoundedJson } from './harness/files.ts';
import { record, text, sha } from './harness/report.ts';

const numeric = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid measurement number');
  return value;
};
/** Recompute quantiles from every match, never average partition medians/p95s. */
export function summarizeLeagueMeasurements(inputs: unknown[]) {
  if (!inputs.length || inputs.length > 1000)
    throw new Error('Expected 1..1000 process observations');
  const ids = new Set<string>(),
    identities = new Set<string>();
  const values: Record<string, number[]> = { wallMs: [] };
  let cpuMs = 0,
    storedBytes = 0,
    incomplete = 0,
    calls = 0;
  const replays = new Set<string>();
  for (const input of inputs) {
    const r = record(input),
      identity = record(r.identity);
    if (r.schemaVersion !== 1 || !['completed', 'failed'].includes(text(r.status)))
      throw new Error('Invalid observation schema/status');
    const id = text(r.observationId);
    if (ids.has(id)) throw new Error('Duplicate process observation');
    ids.add(id);
    identities.add(
      JSON.stringify([sha(identity.sourceSha), text(identity.runId), text(identity.runAttempt)]),
    );
    const cpu = record(r.cpu);
    cpuMs += numeric(cpu.userMs) + numeric(cpu.systemMs);
    incomplete +=
      numeric(r.incompleteSpans) + numeric(r.droppedRecords) + (r.status === 'failed' ? 1 : 0);
    if (!Array.isArray(r.matches) || r.matches.length > 20000)
      throw new Error('Invalid match sample count');
    if (values.wallMs!.length + r.matches.length > 20000)
      throw new Error('Total match sample limit');
    for (const value of r.matches) {
      const match = record(value);
      values.wallMs!.push(numeric(match.wallMs));
      if (match.storedBytes !== undefined) storedBytes += numeric(match.storedBytes);
      if (match.worker)
        for (const [key, amount] of Object.entries(record(match.worker))) {
          if (typeof amount === 'boolean' || key === 'threadId') continue;
          if (
            !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ||
            key in Object.prototype ||
            key === 'wallMs' ||
            Object.keys(values).length > 32
          )
            throw new Error('Invalid Worker metric');
          (values[key] ??= []).push(numeric(amount));
        }
    }
    const validation = record(r.validation);
    calls += numeric(validation.calls);
    for (const id of Object.keys(record(validation.replays))) replays.add(id);
    if (replays.size > 20000) throw new Error('Replay identity limit');
  }
  if (identities.size !== 1) throw new Error('Mixed source/run/attempt observations');
  return {
    schemaVersion: 1,
    identity: JSON.parse([...identities][0]!) as unknown,
    observations: ids.size,
    incompleteObservations: incomplete,
    observedCpuMs: cpuMs,
    observedStoredReplayBytes: storedBytes,
    matchMetrics: Object.fromEntries(
      Object.entries(values).map(([name, samples]) => [name, distribution(samples)]),
    ),
    validation: { calls, uniqueReplays: replays.size, repeatedCalls: calls - replays.size },
    workflowWallMs: null,
    target300Seconds: 'unmeasured',
    coverage:
      'Observed files only; missing jobs/processes and fresh-browser Pages acceptance require separate Actions evidence. Process CPU is additive; spans, job time and memory are not.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory)
    throw new Error(
      'Usage (from apps/cli): node --import tsx ../../scripts/league-measurements.ts timing-directory',
    );
  const names = readdirSync(directory).filter((n) => /^measurement-[a-f0-9-]+\.json$/.test(n));
  if (names.length > 1000) throw new Error('Observation file limit');
  console.log(
    JSON.stringify(
      summarizeLeagueMeasurements(names.map((name) => readBoundedJson(join(directory, name)))),
    ),
  );
}
