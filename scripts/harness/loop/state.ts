import { natural } from '../delivery.ts';
import { record, sha, text, timestamp } from '../report.ts';
import { parseJournal, readJournal, updateJournal } from './journal.ts';
import type { Journal } from './journal.ts';

export type Phase =
  | 'initialized'
  | 'ready'
  | 'running'
  | 'applying'
  | 'candidate'
  | 'review'
  | 'delivery'
  | 'completed'
  | 'stopped';
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function status(value: unknown, now = new Date().toISOString()) {
  const j = parseJournal(value),
    c = j.contract,
    at = timestamp(now);
  ensure(at >= j.events.at(-1)!.at, 'Clock precedes journal');
  const deadline = new Date(Date.parse(j.events[0]!.at) + c.budget.durationMs).toISOString();
  let phase: Phase = 'initialized',
    attempts = 0,
    externalCalls = 0,
    costMicros = 0,
    noProgress = 0;
  let candidateSha = c.baselineSha,
    verifiedSha: string | null = null,
    patchHash: string | null = null;
  let bestPassed = 0,
    reason = 'Not prepared',
    reviewAt: string | null = null;
  for (const e of j.events.slice(1)) {
    const d = e.data;
    ensure(phase !== 'completed' && phase !== 'stopped', 'Terminal task');
    if (e.type !== 'interrupted') ensure(e.at < deadline, 'Deadline exceeded');
    switch (e.type) {
      case 'prepared':
        ensure(phase === 'initialized', 'Already prepared');
        text(d.workspace);
        phase = 'ready';
        break;
      case 'begun':
        ensure(
          ['ready', 'review', 'delivery'].includes(phase),
          'Attempt already active or unprepared',
        );
        ensure(
          attempts < c.budget.attempts && noProgress < c.budget.noProgress,
          'Attempt budget exhausted',
        );
        text(d.hypothesis);
        externalCalls += natural(d.externalCalls);
        costMicros += natural(d.costMicros);
        attempts++;
        ensure(
          externalCalls <= c.budget.externalCalls && costMicros <= c.budget.costMicros,
          'Reservation exceeds budget',
        );
        verifiedSha = null;
        patchHash = null;
        reviewAt = null;
        phase = 'running';
        break;
      case 'applying':
        ensure(
          phase === 'running' &&
            d.baseSha === candidateSha &&
            /^[a-f0-9]{64}$/.test(String(d.patchHash)),
          'Stale patch or attempt',
        );
        patchHash = String(d.patchHash);
        phase = 'applying';
        break;
      case 'applied':
        ensure(phase === 'applying' && d.patchHash === patchHash, 'Patch reservation missing');
        candidateSha = sha(d.candidateSha);
        phase = 'candidate';
        break;
      case 'evaluated': {
        ensure(phase === 'candidate' && d.candidateSha === candidateSha, 'Stale evaluation');
        const passed = natural(d.passed);
        ensure(['pass', 'fail', 'unknown'].includes(String(d.outcome)), 'Invalid evaluation');
        text(d.evidence);
        if (d.outcome === 'pass') {
          verifiedSha = candidateSha;
          reviewAt = e.at;
          phase = 'review';
        } else {
          noProgress = passed > bestPassed ? 0 : noProgress + 1;
          bestPassed = Math.max(bestPassed, passed);
          phase = 'ready';
        }
        break;
      }
      case 'reviewed':
        ensure(phase === 'review' && d.candidateSha === verifiedSha, 'Stale review');
        ensure(d.method === 'self' || d.method === 'human', 'Unknown review method');
        ensure(d.method !== 'self' || c.review !== 'required', 'Required review cannot fall back');
        ensure(
          d.method !== 'self' ||
            c.review !== 'optional' ||
            Date.parse(e.at) >= Date.parse(reviewAt!) + c.reviewWaitMs,
          'Optional review wait not elapsed',
        );
        ensure(d.unresolvedFindings === 0, 'Review findings remain');
        text(d.evidence);
        phase = 'delivery';
        break;
      case 'observed':
        ensure(phase === 'delivery' && d.candidateSha === verifiedSha, 'Stale delivery');
        text(d.evidence);
        ensure(typeof d.complete === 'boolean', 'Missing delivery result');
        if (d.complete) phase = 'completed';
        break;
      case 'interrupted':
        text(d.reason);
        noProgress++;
        verifiedSha = null;
        reviewAt = null;
        phase = 'ready';
        break;
      case 'stopped':
        text(d.reason);
        phase = 'stopped';
        break;
      default:
        throw new Error('Unknown loop event');
    }
    reason = e.type;
  }
  if (
    phase !== 'completed' &&
    (at >= deadline ||
      (phase === 'ready' && (attempts >= c.budget.attempts || noProgress >= c.budget.noProgress)))
  ) {
    phase = 'stopped';
    reason = at >= deadline ? 'deadline' : 'attempt/no-progress budget';
  }
  const nextAction: Record<Phase, string> = {
    initialized: 'prepare',
    ready: 'begin',
    running: 'apply',
    applying: 'recover',
    candidate: 'evaluate',
    review: 'review',
    delivery: 'observe',
    completed: 'none',
    stopped: 'normal-engineering-handoff',
  };
  return {
    revision: j.revision,
    phase: phase as Phase,
    reason,
    candidateSha,
    verifiedSha,
    patchHash,
    deadline,
    reviewAt,
    attempts,
    noProgress,
    externalCalls,
    costMicros,
    nextAction: nextAction[phase],
    remaining: {
      attempts: Math.max(0, c.budget.attempts - attempts),
      externalCalls: c.budget.externalCalls - externalCalls,
      costMicros: c.budget.costMicros - costMicros,
      durationMs: Math.max(0, Date.parse(deadline) - Date.parse(at)),
    },
  };
}
export function transition(
  path: string,
  journal: Journal,
  type: string,
  data: Record<string, unknown>,
  at = new Date().toISOString(),
) {
  ensure(status(journal, at).phase !== 'stopped', 'Loop budget exhausted');
  return updateJournal(path, journal.revision, type, data, at, status);
}
export function begin(path: string, value: unknown, at = new Date().toISOString()) {
  const reservation = record(value);
  return transition(
    path,
    readJournal(path),
    'begun',
    {
      hypothesis: text(reservation.hypothesis),
      externalCalls: natural(reservation.externalCalls),
      costMicros: natural(reservation.costMicros),
    },
    at,
  );
}
