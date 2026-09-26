import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationError, operationCode, type OperationCode } from '@fantasy/api/tooling';
import { PublicationFailure } from '../publication/publication-remote.ts';
import { writeCloudJson } from './league-cloud-files.ts';

const commands = {
  probe: 'planning',
  prepare: 'planning',
  restore: 'restoration',
  admit: 'publication',
  run: 'execution',
  finish: 'validation',
  publish: 'publication',
} as const;
type Command = keyof typeof commands;
type Retry = 'conditional' | 'no' | 'unknown';
const descriptions = {
  INPUT_INVALID: [
    'Input or configuration is invalid.',
    'Correct the committed input or Actions configuration.',
    'no',
  ],
  IDENTITY_MISMATCH: [
    'Execution identity does not match.',
    'Use tested main and start a new complete workflow; preserve attempt history.',
    'no',
  ],
  BUDGET_EXCEEDED: [
    'Capacity or request budget was exceeded.',
    'Check estimates, retained capacity and consumed leases before a new run; do not reset usage.',
    'conditional',
  ],
  DATA_INVALID: [
    'Saved data failed validation.',
    'Investigate the retained data and checksums; do not reuse or overwrite damaged results.',
    'no',
  ],
  PUBLICATION_CONFLICT: [
    'Publication conflicts with retained data or the current generation.',
    'Read back the current generation and investigate competing publication before retrying.',
    'conditional',
  ],
  REMOTE_AUTH: [
    'Remote access was rejected.',
    'Check the protected Actions Environment credentials and permissions.',
    'no',
  ],
  REMOTE_UNAVAILABLE: [
    'A remote operation could not be completed.',
    'Check service availability and consumed leases before retrying.',
    'conditional',
  ],
  USAGE_CONSUMED: [
    'This usage lease has already been consumed.',
    'Preserve usage history; start a new complete workflow only after checking prior results.',
    'no',
  ],
  USAGE_UNVERIFIED: [
    'The durable usage reservation was not verified.',
    'Read back the usage ledger and investigate; never refund or blindly repeat a possibly consumed lease.',
    'unknown',
  ],
  PUBLICATION_NOT_COMMITTED: [
    'The publication pointer was not committed by this operation.',
    'Correct the failure, then verify the current generation and reuse the identical publication input.',
    'conditional',
  ],
  PUBLICATION_COMMIT_UNKNOWN: [
    'The publication result is unknown.',
    'Read back the current pointer and checksums first. Recover only with identical publication input; do not start a different publication or replay a consumed lease.',
    'unknown',
  ],
  PUBLICATION_UNVERIFIED: [
    'The publication is committed but read-back verification is incomplete.',
    'Verify R2 and Worker read-back using the identical publication input; do not replace it or replay a consumed lease.',
    'conditional',
  ],
  UNKNOWN: [
    'An unclassified operation failed.',
    'Investigate the failed phase manually before retrying; private exception details were omitted.',
    'unknown',
  ],
} as const satisfies Record<
  | OperationCode
  | 'PUBLICATION_NOT_COMMITTED'
  | 'PUBLICATION_COMMIT_UNKNOWN'
  | 'PUBLICATION_UNVERIFIED'
  | 'UNKNOWN',
  readonly [string, string, Retry]
>;
type Code = keyof typeof descriptions;

export interface LeagueFailureContext {
  command?: string;
  executionId?: string;
  validating?: boolean;
}

/** No arbitrary strings, exception traversal, URLs, messages, stacks or response bodies. */
export function leagueFailure(error: unknown, context: LeagueFailureContext) {
  const command =
    context.command && Object.hasOwn(commands, context.command)
      ? (context.command as Command)
      : 'unknown';
  const schemaCode =
    command === 'probe' || command === 'prepare' || context.validating
      ? 'INPUT_INVALID'
      : 'DATA_INVALID';
  let classified: unknown = operationCode(error, schemaCode);
  let publicationState: PublicationFailure['phase'] | undefined;
  if (error instanceof PublicationFailure) {
    publicationState = error.phase;
    if (error.phase === 'commit-unknown') classified = 'PUBLICATION_COMMIT_UNKNOWN';
    else if (error.phase === 'committed-unverified') classified = 'PUBLICATION_UNVERIFIED';
    else if (error.phase === 'not-committed') {
      // Only the known wrapper's direct typed cause is classified, never serialized or traversed.
      classified = operationCode(error.cause, 'DATA_INVALID');
      if (classified === 'UNKNOWN') classified = 'PUBLICATION_NOT_COMMITTED';
    } else publicationState = undefined;
  }
  const code: Code =
    typeof classified === 'string' && Object.hasOwn(descriptions, classified)
      ? (classified as Code)
      : 'UNKNOWN';
  const [message, action, retry] = descriptions[code];
  const target = error instanceof OperationError ? error.targetHash : undefined;
  // Match the entire identifier: JavaScript's $ also accepts a final line terminator.
  return {
    schemaVersion: 1,
    status: 'failed',
    command,
    phase: context.validating || command === 'unknown' ? 'validation' : commands[command],
    code,
    message,
    retry,
    action,
    ...(publicationState ? { publicationState } : {}),
    ...(typeof target === 'string' && target.match(/^sha256:[a-f0-9]{64}$/)?.[0] === target
      ? { targetHash: target }
      : {}),
    ...(context.executionId &&
    context.executionId.match(/^league-[0-9]{1,20}-[0-9]{1,5}$/)?.[0] === context.executionId
      ? { executionId: context.executionId }
      : {}),
  } as const;
}

export function leagueFailureSummary(report: ReturnType<typeof leagueFailure>) {
  return (
    `### League failure: ${report.code}\n\n` +
    `- Phase: ${report.phase} (${report.command})\n` +
    `- What happened: ${report.message}\n` +
    `- Retry: ${report.retry}\n` +
    `- Next action: ${report.action}\n` +
    (report.publicationState ? `- Publication: ${report.publicationState}\n` : '') +
    (report.executionId ? `- Execution: ${report.executionId}\n` : '') +
    (report.targetHash ? `- Target: ${report.targetHash}\n` : '')
  );
}

export async function reportLeagueFailure(
  error: unknown,
  context: LeagueFailureContext,
  root?: string,
  summaryPath?: string,
) {
  const report = leagueFailure(error, context);
  console.error(JSON.stringify(report));
  const writes = await Promise.allSettled([
    ...(root
      ? [writeCloudJson(join(root, 'reports', `failure-${report.command}.json`), report)]
      : []),
    ...(summaryPath ? [appendFile(summaryPath, leagueFailureSummary(report))] : []),
  ]);
  if (writes.some((write) => write.status === 'rejected'))
    console.error(
      'LEAGUE_REPORT_WRITE_FAILED: original operation remains failed; use the structured stderr report.',
    );
}
