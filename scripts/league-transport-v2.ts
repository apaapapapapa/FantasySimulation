import { z } from 'zod';

/** Off-mode model only. No workflow or execution path consumes this v2 contract. */
export const TRANSPORT_V2_LIMITS = Object.freeze({
  runners: 4,
  partitions: 64,
  partitionsPerRunner: 16,
  producerRefs: 48,
  jobRefs: 50,
  globalRefs: 256,
  producerControlRefs: 2,
  sharedControlRefs: 5,
  rawArchiveBytes: 48 * 1024 ** 2,
  producerControlBytes: 16 * 1024 ** 2,
  producerFiles: 4096,
});
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sourceSha = z.string().regex(/^[a-f0-9]{40}$/);
const partition = z.number().int().min(0).max(63);
const integer = z.number().int().nonnegative().safe();
const outputClaim = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({
    kind: z.literal('deterministic-next-fit-v1'),
    sourceSha,
    inputHash: hash,
    proofHash: hash,
    controlBytesUpper: integer.positive(),
    totalFileBytesUpper: integer.positive(),
    maxFileBytesUpper: integer.positive(),
    fileCountUpper: integer.positive(),
  }),
]);
export const OffModeTransportV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  mode: z.literal('off'),
  sourceSha,
  planId: hash,
  inputs: z
    .array(z.strictObject({ partition, inputHash: hash, output: outputClaim }))
    .min(1)
    .max(64),
  assignments: z
    .array(
      z.strictObject({
        runner: z.number().int().min(0).max(3),
        partitions: z.array(partition).min(1).max(16),
      }),
    )
    .min(1)
    .max(4),
});
export type OffModeTransportV2 = z.infer<typeof OffModeTransportV2Schema>;
export type TransportV2Rejection =
  | 'INPUT_INVALID'
  | 'OUTPUT_UNKNOWN'
  | 'OUTPUT_PROOF_BINDING'
  | 'OUTPUT_BOUND_UNSUPPORTED'
  | 'EXECUTION_DISABLED';
export class TransportV2Error extends Error {
  constructor(
    readonly code: TransportV2Rejection,
    message: string,
  ) {
    super(message);
    this.name = 'TransportV2Error';
  }
}
function reject(code: TransportV2Rejection, message: string): never {
  throw new TransportV2Error(code, message);
}

/** Checks a sufficient ref-count claim, not its truth, provenance or ZIP byte bound. */
export function inspectOffModeTransportV2(input: unknown) {
  const parsed = OffModeTransportV2Schema.safeParse(input);
  if (!parsed.success) reject('INPUT_INVALID', 'Strict off-mode transport v2 contract required');
  const model = parsed.data;
  const inputs = new Map(model.inputs.map((entry) => [entry.partition, entry]));
  const coverage = model.assignments.flatMap((assignment) => assignment.partitions);
  if (
    inputs.size !== model.inputs.length ||
    model.inputs.some((entry, index) => entry.partition !== index) ||
    model.assignments.some((assignment, index) => assignment.runner !== index) ||
    coverage.length !== inputs.size ||
    new Set(coverage).size !== coverage.length ||
    coverage.some((index) => !inputs.has(index))
  )
    reject('INPUT_INVALID', 'Exact canonical input and runner partition coverage required');
  for (const entry of model.inputs) {
    const claim = entry.output;
    if (claim.kind === 'unknown')
      reject('OUTPUT_UNKNOWN', 'Precompute deterministic output proof missing');
    if (claim.sourceSha !== model.sourceSha || claim.inputHash !== entry.inputHash)
      reject('OUTPUT_PROOF_BINDING', 'Output proof source/input binding mismatch');
    const capacity = TRANSPORT_V2_LIMITS.rawArchiveBytes - claim.controlBytesUpper;
    // Next-fit >=4 nonempty bins implies bins1+2>C and bins3+4>C, hence total>2C.
    // Byte sum alone never proves a two-bin packing or a real encoder ZIP bound.
    if (
      claim.controlBytesUpper > TRANSPORT_V2_LIMITS.producerControlBytes ||
      claim.fileCountUpper > TRANSPORT_V2_LIMITS.producerFiles ||
      capacity <= 0 ||
      claim.maxFileBytesUpper > capacity ||
      claim.totalFileBytesUpper > 2 * capacity ||
      claim.maxFileBytesUpper > claim.totalFileBytesUpper
    )
      reject('OUTPUT_BOUND_UNSUPPORTED', 'Insufficient next-fit <=3 ref-count upper-bound claim');
  }
  const runners = model.assignments.map((assignment) => ({
    runner: assignment.runner,
    partitions: assignment.partitions.length,
    // Reserve every legacy fallback. Singleton timer flush and pairing save no budget.
    producerRefsUpper: assignment.partitions.length * 3,
    jobRefsUpper: assignment.partitions.length * 3 + TRANSPORT_V2_LIMITS.producerControlRefs,
  }));
  const globalRefsUpper =
    model.inputs.length * 3 +
    model.assignments.length * TRANSPORT_V2_LIMITS.producerControlRefs +
    TRANSPORT_V2_LIMITS.sharedControlRefs;
  if (
    runners.some(
      (runner) =>
        runner.producerRefsUpper > TRANSPORT_V2_LIMITS.producerRefs ||
        runner.jobRefsUpper > TRANSPORT_V2_LIMITS.jobRefs,
    ) ||
    globalRefsUpper > TRANSPORT_V2_LIMITS.globalRefs
  )
    reject('INPUT_INVALID', 'Finite transport v2 reference budget exceeded');
  return {
    schemaVersion: 2 as const,
    mode: 'off' as const,
    status: 'model-only' as const,
    executionEnabled: false as const,
    runners,
    globalRefsUpper,
    remainingGates: [
      'authenticated-output-proof',
      'encoded-archive-byte-bound',
      'metadata-transfer-retry-and-storage-budget',
      'same-source-whole-critical-path',
    ] as const,
  };
}

/** Even structurally valid claims cannot enable compute, R2 or publication. */
export function requireTransportV2Execution(input: unknown): never {
  inspectOffModeTransportV2(input);
  return reject(
    'EXECUTION_DISABLED',
    'Transport v2 is off; output, cost and capacity gates remain closed',
  );
}
