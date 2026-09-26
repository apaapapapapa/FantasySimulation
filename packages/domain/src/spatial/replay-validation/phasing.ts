import type { ActorDisplay, StreamRecord, DisplayState } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import { requireReplay, same } from './common.ts';

export function validatePhasing(context: ReplayContext, actor: ActorDisplay, nextEvent: number) {
  const phase = actor.phasing;
  if (!phase) return;
  requireReplay(phase.exitPending || phase.retained.length === 0, 'phasing retained exit');
  requireReplay(phase.exitPending || phase.extendedIntervals === 0, 'phasing counter without exit');
  const seen = new Set<string>();
  for (const contribution of [...phase.active, ...phase.retained]) {
    const { revision } = contribution;
    const status = context.manifest.revisions.find(
      (r) =>
        r.kind === 'status' &&
        r.id === revision.id &&
        r.revision === revision.revision &&
        r.contentHash === revision.contentHash,
    );
    const spec = status?.kind === 'status' ? status.definition.phasing : undefined;
    requireReplay(
      !!spec &&
        contribution.materials.every((m) => spec.materials.includes(m)) &&
        (!contribution.floor || spec.floor),
      'phasing source/material',
    );
    requireReplay(
      new Set(contribution.causes).size === contribution.causes.length &&
        contribution.causes.every((id) => /^e\.\d+$/.test(id) && Number(id.slice(2)) < nextEvent),
      'phasing causes',
    );
    if (phase.active.includes(contribution))
      requireReplay(
        !!spec && same(contribution.materials, spec.materials) && contribution.floor === spec.floor,
        'active phasing mask',
      );
    const key = JSON.stringify(contribution);
    requireReplay(!seen.has(key), 'duplicate phasing contribution');
    seen.add(key);
  }
}
export function validatePhasingTransition(
  prior: ReplayCheckpoint,
  state: DisplayState,
  record: Extract<StreamRecord, { kind: 'boundary' | 'interval' }>,
) {
  if (!prior.state) return;
  for (const actor of state.actors) {
    const old = prior.state.actors.find((a) => a.id === actor.id)!.phasing,
      next = actor.phasing;
    if (record.kind === 'interval') {
      if (!old) requireReplay(!next, 'phasing must activate at a boundary');
      else
        requireReplay(
          !!next &&
            same(
              { ...old, extendedIntervals: old.extendedIntervals + Number(old.exitPending) },
              next,
            ),
          'phasing executed interval counter',
        );
    } else {
      if (old?.exitPending && next?.exitPending)
        requireReplay(
          next.extendedIntervals === old.extendedIntervals,
          'phasing refresh cannot reset exit',
        );
      else if (next?.exitPending)
        requireReplay(next.extendedIntervals === 0, 'phasing exit starts at zero');
      for (const c of next?.active ?? [])
        requireReplay(
          actor.statuses.some(
            (s) =>
              same(s.revision, c.revision) && s.startStep <= record.step && record.step < s.endStep,
          ),
          'active phasing cohort',
        );
    }
  }
}
