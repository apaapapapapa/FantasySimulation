import { expect, it } from 'vite-plus/test';
import { LeagueProducerTerminalSchema } from '@fantasy/domain/spatial';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import { pipelineCapacity } from './league-pipeline-policy.ts';
import {
  inspectOffModeTransportV2,
  requireTransportV2Execution,
  TransportV2Error,
  TRANSPORT_V2_LIMITS,
  type OffModeTransportV2,
  type TransportV2Rejection,
} from './league-transport-v2.ts';

const MiB = 1024 ** 2;
function fixture(partitions = 60, runners = 4): OffModeTransportV2 {
  return {
    schemaVersion: 2,
    mode: 'off',
    sourceSha: 'a'.repeat(40),
    planId: 'sha256:' + 'b'.repeat(64),
    inputs: Array.from({ length: partitions }, (_, partition) => ({
      partition,
      inputHash: 'sha256:' + 'c'.repeat(64),
      output: {
        kind: 'deterministic-next-fit-v1',
        sourceSha: 'a'.repeat(40),
        inputHash: 'sha256:' + 'c'.repeat(64),
        proofHash: 'sha256:' + 'd'.repeat(64),
        controlBytesUpper: MiB,
        totalFileBytesUpper: 90 * MiB,
        maxFileBytesUpper: 30 * MiB,
        fileCountUpper: 3,
      },
    })),
    assignments: Array.from({ length: runners }, (_, runner) => ({
      runner,
      partitions: Array.from({ length: partitions }, (_, i) => i).filter(
        (i) => i % runners === runner,
      ),
    })),
  };
}
function rejects(input: unknown, code: TransportV2Rejection) {
  try {
    inspectOffModeTransportV2(input);
  } catch (error) {
    expect(error).toBeInstanceOf(TransportV2Error);
    expect((error as TransportV2Error).code).toBe(code);
    return;
  }
  throw new Error('Invalid model accepted');
}
it.each([
  [60, 45, 47, 193],
  [64, 48, 50, 205],
])(
  'reserves every singleton/fallback at %i partitions with four runners',
  (parts, refs, jobs, global) => {
    const report = inspectOffModeTransportV2(fixture(parts));
    expect(report).toMatchObject({
      mode: 'off',
      status: 'model-only',
      executionEnabled: false,
      globalRefsUpper: global,
    });
    expect(report.runners).toHaveLength(4);
    for (const runner of report.runners)
      expect(runner).toMatchObject({ producerRefsUpper: refs, jobRefsUpper: jobs });
    expect(report.remainingGates).toContain('authenticated-output-proof');
    expect(report.remainingGates).toContain('same-source-whole-critical-path');
  },
);
it('keeps v1 limits and the whole execution gate closed', () => {
  const input = fixture();
  expect(() => pipelineCapacity(60, input.assignments)).toThrow('Preflight artifact quota');
  expect(
    LeagueProducerTerminalSchema.safeParse({
      schemaVersion: 1,
      identity: pipelineActionsFixture().identity,
      runner: 0,
      partitions: [0],
      artifacts: Array.from({ length: 31 }, (_, index) => ({
        id: index + 1,
        digest: 'sha256:' + 'f'.repeat(64),
        name: 'league-test-' + index,
        bytes: 1,
      })),
    }).success,
  ).toBe(false);
  expect(TRANSPORT_V2_LIMITS).toMatchObject({
    runners: 4,
    partitions: 64,
    partitionsPerRunner: 16,
    producerRefs: 48,
    jobRefs: 50,
    globalRefs: 256,
  });
  expect(Object.isFrozen(TRANSPORT_V2_LIMITS)).toBe(true);
  try {
    requireTransportV2Execution(input);
  } catch (error) {
    expect((error as TransportV2Error).code).toBe('EXECUTION_DISABLED');
    return;
  }
  throw new Error('Off-mode enabled execution');
});
it('rejects unknown proof before modeling references or attempting execution', () => {
  const input = fixture();
  input.inputs[0]!.output = { kind: 'unknown' };
  rejects(input, 'OUTPUT_UNKNOWN');
  expect(() => requireTransportV2Execution(input)).toThrow(
    'Precompute deterministic output proof missing',
  );
});
it('rejects four 33MiB files although their total fits the old 256MiB output envelope', () => {
  const input = fixture();
  const claim = input.inputs[0]!.output;
  if (claim.kind !== 'deterministic-next-fit-v1') throw new Error('Fixture claim');
  Object.assign(claim, {
    totalFileBytesUpper: 132 * MiB,
    maxFileBytesUpper: 33 * MiB,
    fileCountUpper: 4,
  });
  expect(claim.totalFileBytesUpper).toBeLessThan(256 * MiB);
  rejects(input, 'OUTPUT_BOUND_UNSUPPORTED');
});
it.each(['sourceSha', 'inputHash'] as const)('rejects a foreign proof %s', (field) => {
  const input = fixture();
  const claim = input.inputs[0]!.output;
  if (claim.kind !== 'deterministic-next-fit-v1') throw new Error('Fixture claim');
  claim[field] = field === 'sourceSha' ? 'e'.repeat(40) : 'sha256:' + 'e'.repeat(64);
  rejects(input, 'OUTPUT_PROOF_BINDING');
});
it.each([
  { controlBytesUpper: 16 * MiB + 1 },
  { fileCountUpper: 4097 },
  { maxFileBytesUpper: 47 * MiB + 1 },
  { totalFileBytesUpper: 94 * MiB + 1 },
  { totalFileBytesUpper: MiB, maxFileBytesUpper: 2 * MiB },
])('rejects an unsupported output envelope %j', (change) => {
  const input = fixture();
  Object.assign(input.inputs[0]!.output, change);
  rejects(input, 'OUTPUT_BOUND_UNSUPPORTED');
});
it('accepts only the sufficient <=3 count bound, never claims two bins or ZIP bytes', () => {
  const input = fixture(1, 1);
  const claim = input.inputs[0]!.output;
  if (claim.kind !== 'deterministic-next-fit-v1') throw new Error('Fixture claim');
  Object.assign(claim, { totalFileBytesUpper: 94 * MiB, maxFileBytesUpper: 47 * MiB });
  const report = inspectOffModeTransportV2(input);
  expect(report.runners[0]!.producerRefsUpper).toBe(3);
  expect(report.remainingGates).toContain('encoded-archive-byte-bound');
});
it.each([
  (x: OffModeTransportV2) => {
    x.mode = 'on' as 'off';
  },
  (x: OffModeTransportV2) => {
    x.schemaVersion = 1 as 2;
  },
  (x: OffModeTransportV2) => {
    x.assignments[0]!.partitions.push(63, 62);
  },
  (x: OffModeTransportV2) => {
    x.assignments.push({ runner: 4, partitions: [0] });
  },
  (x: OffModeTransportV2) => {
    x.assignments[0]!.partitions[0] = 1;
  },
  (x: OffModeTransportV2) => {
    x.assignments[0]!.partitions.pop();
  },
  (x: OffModeTransportV2) => {
    x.assignments[0]!.runner = 1;
  },
  (x: OffModeTransportV2) => {
    x.inputs[1]!.partition = 0;
  },
  (x: OffModeTransportV2) => {
    x.inputs[0]!.partition = 63;
  },
  (x: OffModeTransportV2) => {
    Object.assign(x, { producerRefs: 49 });
  },
  (x: OffModeTransportV2) => {
    Object.assign(x.inputs[0]!.output, { totalFileBytesUpper: NaN });
  },
  (x: OffModeTransportV2) => {
    Object.assign(x.inputs[0]!.output, { controlBytesUpper: -1 });
  },
])('rejects scope, coverage and malformed bounds %i', (mutate) => {
  const input = fixture();
  mutate(input);
  rejects(input, 'INPUT_INVALID');
});
