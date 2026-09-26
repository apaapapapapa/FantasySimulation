import type { Outcome } from '../records.ts';
import type { ReplayContext } from './context.ts';
import { emittedId, requireReplay } from './common.ts';

/** Validate saved causal metadata using only manifest and committed replay cursors. */
export function validateInterferences(
  context: ReplayContext,
  outcome: Outcome,
  step: number,
  nextEvent: number,
) {
  if (outcome.kind === 'truncated' && outcome.details)
    requireReplay(
      context.rules.interferenceDiagnostics === 'v1' ||
        [
          'spatial-commands',
          'spatial-objects',
          'spatial-phase-contributions',
          'phase-exit-steps',
        ].includes(outcome.resource),
      'truncation diagnostics permission',
    );
  if (outcome.kind !== 'unresolved' || !outcome.interferences) return;
  requireReplay(
    context.rules.interferenceDiagnostics === 'v1',
    'interference diagnostics permission',
  );
  for (const entry of outcome.interferences) {
    requireReplay(
      entry.step === step && step < context.rules.maxSteps && entry.ruleId === outcome.ruleId,
      'interference boundary/rule',
    );
    for (const actor of entry.actors)
      requireReplay(
        context.actors.some((a) => a.participant.actorId === actor),
        'interference actor',
      );
    for (const ref of entry.revisions)
      requireReplay(
        context.manifest.revisions.some(
          (r) =>
            r.kind === ref.kind &&
            r.id === ref.id &&
            r.revision === ref.revision &&
            r.contentHash === ref.contentHash,
        ),
        'interference revision',
      );
    requireReplay(
      outcome.revisions.every((id) =>
        entry.revisions.some((r) => r.kind === 'status' && r.id === id),
      ),
      'interference status identity',
    );
    for (const cause of entry.causes) {
      if (cause.kind === 'event') {
        requireReplay(emittedId(cause.eventId) < nextEvent, 'interference committed cause');
        continue;
      }
      const actor = context.actors.find((a) => a.participant.actorId === cause.actorId);
      requireReplay(
        cause.step === step &&
          (cause.actorId === null || (!!actor && entry.actors.includes(cause.actorId))),
        'interference attempted actor/boundary',
      );
      if (cause.ability) {
        const ref = cause.ability;
        requireReplay(
          !!actor?.abilities.some(
            (a) =>
              a.id === ref.id && a.revision === ref.revision && a.contentHash === ref.contentHash,
          ) &&
            entry.revisions.some(
              (r) =>
                r.kind === 'ability' &&
                r.id === ref.id &&
                r.revision === ref.revision &&
                r.contentHash === ref.contentHash,
            ),
          'interference attempted ability ownership',
        );
      }
    }
  }
}
