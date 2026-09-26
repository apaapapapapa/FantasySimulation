import {
  statusSealed,
  statusActive,
  type ActorDisplay,
  type ReplayContext,
} from '@fantasy/domain/spatial';

/** Presentation derives only from recorded cohorts and their sealed saved definitions. */
export function sealDisplay(context: ReplayContext, actor: ActorDisplay, step: number) {
  const statuses = actor.statuses.map((s) => {
    const revision = context.manifest.revisions.find(
      (r) =>
        r.kind === 'status' &&
        r.id === s.revision.id &&
        r.revision === s.revision.revision &&
        r.contentHash === s.revision.contentHash,
    );
    if (!revision || revision.kind !== 'status') throw new Error('Missing saved status');
    return { ...s, revision };
  });
  return statuses.map((s) => ({
    id: s.revision.id,
    active: statusActive(s, step),
    sealing: statusActive(s, step) && !!s.revision.definition.seals,
    suppressed: statusActive(s, step) && statusSealed(s, statuses, step),
  }));
}
