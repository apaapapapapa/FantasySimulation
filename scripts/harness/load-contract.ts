import { createHash } from 'node:crypto';
import { record, sha, text } from './report.ts';

export const COST_KEYS = [
  'steps',
  'casts',
  'candidates',
  'pathNodes',
  'events',
  'logBytes',
  'trajectoryBytes',
] as const;
export type Costs = Record<(typeof COST_KEYS)[number], number>;
export interface LoadProfile {
  schemaVersion: 1;
  id: string;
  warmups: number;
  samples: number;
  limits: Record<string, Costs>;
}
export const bytesHash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
export function fixtureHash(value: unknown): string {
  const corpus = record(value);
  return bytesHash(JSON.stringify({ contract: corpus.contract, entries: corpus.entries }));
}
export function counts(value: unknown): Costs {
  const data = record(value);
  if (Object.keys(data).sort().join() !== [...COST_KEYS].sort().join())
    throw new Error('Incomplete metric coverage');
  for (const key of COST_KEYS)
    if (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0)
      throw new Error(`Missing or invalid metric: ${key}`);
  return data as Costs;
}
export function loadProfile(value: unknown): LoadProfile {
  const data = record(value);
  if (data.schemaVersion !== 1 || data.warmups !== 1 || data.samples !== 5)
    throw new Error('Unsupported load profile');
  const limits = Object.fromEntries(
    Object.entries(record(data.limits)).map(([id, values]) => [text(id), counts(values)]),
  );
  if (!Object.keys(limits).length || Object.keys(limits).length > 64)
    throw new Error('Empty/oversized load profile');
  return { schemaVersion: 1, id: text(data.id), warmups: 1, samples: 5, limits };
}
export interface Sample {
  id: string;
  inputHash: string;
  outcome: string;
  costs: Costs;
  elapsedMs: number;
  cpuMicros: number;
  peakRssBytes: number | null;
  memoryReason: string | null;
}
export interface Capture {
  schemaVersion: 1;
  sourceState: 'clean' | 'working-tree';
  runnerId: string;
  sourceSha: string;
  driverSha: string;
  driverHash: string;
  corpusHash: string;
  fixtureHash: string;
  profileHash: string;
  toolchain: {
    node: string;
    packageManager: string;
    lockHash: string;
    platform: string;
    arch: string;
    cpu: string;
    cores: number;
  };
  engine: unknown;
  samples: Sample[];
}
export function capture(value: unknown): Capture {
  const data = record(value);
  if (
    data.schemaVersion !== 1 ||
    !['clean', 'working-tree'].includes(String(data.sourceState)) ||
    !Array.isArray(data.samples) ||
    !data.samples.length ||
    data.samples.length > 640
  )
    throw new Error('Missing capture samples');
  sha(data.sourceSha);
  sha(data.driverSha);
  text(data.runnerId);
  for (const key of ['driverHash', 'corpusHash', 'fixtureHash', 'profileHash'])
    if (!/^[a-f0-9]{64}$/.test(text(data[key]))) throw new Error(`Invalid ${key}`);
  const environment = record(data.toolchain);
  for (const key of ['node', 'packageManager', 'lockHash', 'platform', 'arch', 'cpu'])
    text(environment[key]);
  if (!Number.isSafeInteger(environment.cores) || Number(environment.cores) < 1)
    throw new Error('Missing CPU observations');
  record(data.engine);
  for (const row of data.samples) {
    const sample = record(row);
    text(sample.id);
    text(sample.inputHash);
    if (!['win', 'draw', 'unresolved', 'truncated'].includes(text(sample.outcome)))
      throw new Error('Invalid outcome');
    counts(sample.costs);
    for (const key of ['elapsedMs', 'cpuMicros'])
      if (typeof sample[key] !== 'number' || !Number.isFinite(sample[key]) || sample[key] < 0)
        throw new Error(`Invalid performance metric: ${key}`);
    if (sample.peakRssBytes === null) text(sample.memoryReason);
    else if (
      typeof sample.peakRssBytes !== 'number' ||
      !Number.isFinite(sample.peakRssBytes) ||
      sample.peakRssBytes <= 0
    )
      throw new Error('Invalid memory observation');
  }
  return data as unknown as Capture;
}
export const percentile = (values: number[], quantile: number) => {
  if (!values.length) throw new Error('No observations');
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)]!;
};
