import type { ActorDisplay, ProjectileDisplay, StreamRecord } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import { requireReplay, same } from './common.ts';

/** Validate recorded clocks/projections without importing or running battle rules. */
export function validateClocks(
  context: ReplayContext,
  prior: readonly ActorDisplay[] | undefined,
  actors: readonly ActorDisplay[],
  priorProjectiles: readonly ProjectileDisplay[] | undefined,
  projectiles: readonly ProjectileDisplay[],
  record: StreamRecord,
  transition = true,
) {
  const step = record.kind === 'interval' ? record.toStep : record.step;
  const events = 'events' in record ? record.events : [];
  for (const actor of actors) {
    const before = prior?.find((value) => value.id === actor.id),
      clock = actor.clock;
    if (!clock) {
      requireReplay(!before?.clock, 'subject clock removed');
      continue;
    }
    requireReplay(
      !!context.rules.experimental?.mechanics.includes('time-stop'),
      'subject clock permission',
    );
    let end = 0,
      total = 0;
    for (const period of clock.periods ?? []) {
      requireReplay(
        period.from >= end && period.to >= period.from && period.to <= step,
        'subject pause periods',
      );
      total += period.to - period.from;
      end = period.to;
    }
    if (clock.frozen) {
      requireReplay(
        clock.frozen.from >= end &&
          clock.frozen.from <= step &&
          step <= clock.frozen.until &&
          clock.frozen.until - clock.frozen.from <= 100,
        'subject freeze interval',
      );
      total += step - clock.frozen.from;
    }
    requireReplay(
      clock.projectionAsOfGlobalStep === step &&
        clock.pausedSteps === total &&
        clock.subjectStep === step - total,
      'subject clock value',
    );
    const expected = before?.clock
      ? before.clock.subjectStep + Number(record.kind === 'interval' && !before.clock.frozen)
      : step;
    if (transition) requireReplay(clock.subjectStep === expected, 'subject clock advancement');
    if (transition && !before?.clock)
      requireReplay(
        events.some(
          (event) =>
            event.timeStop?.state === 'activated' &&
            event.targetId === actor.id &&
            event.timeStop.controlId === clock.frozen?.controlId,
        ),
        'subject clock activation',
      );
    if (before?.clock?.frozen && !clock.frozen)
      requireReplay(
        events.some(
          (event) =>
            event.timeStop?.state === 'release' &&
            event.timeStop.controlId === before.clock!.frozen!.controlId,
        ),
        'subject clock release',
      );
    const expectedDeadlines = new Map<string, number>([
      ...(actor.action
        ? ([
            ['action.launch', actor.action.launchAt],
            ['action.recovery', actor.action.recoveryUntil],
          ] as [string, number][])
        : []),
      ...actor.statuses.map((status, i): [string, number] => [`status.${i}.end`, status.endStep]),
      ...(actor.forceSchedule ?? []).map((force, i): [string, number] => [
        `force.${i}.end`,
        force.endAt,
      ]),
      ...(actor.reactions ?? []).flatMap((reaction, i): [string, number][] =>
        reaction.state === 'queued' ? [[`reaction.${i}.ready`, reaction.readyAt]] : [],
      ),
    ]);
    // The terminal interval hides a completed action before the next declaration
    // removes its timer cache. Both recorded deadlines must already be elapsed.
    if (!actor.action) {
      const launch = clock.deadlines.find((deadline) => deadline.key === 'action.launch'),
        recovery = clock.deadlines.find((deadline) => deadline.key === 'action.recovery');
      if (launch || recovery) {
        requireReplay(
          !!launch && !!recovery && launch.at <= recovery.at && recovery.at <= clock.subjectStep,
          'completed action deadlines',
        );
        expectedDeadlines.set('action.launch', launch!.projectedStep);
        expectedDeadlines.set('action.recovery', recovery!.projectedStep);
      }
    }
    const keys = new Set<string>();
    for (const deadline of clock.deadlines) {
      const boundDomain = deadline.key.startsWith('status.')
        ? 'status'
        : deadline.key.startsWith('force.')
          ? 'motion'
          : 'action';
      requireReplay(
        !keys.has(deadline.key) &&
          expectedDeadlines.has(deadline.key) &&
          deadline.domain === boundDomain &&
          deadline.projectedStep === deadline.at + total &&
          deadline.remainingSteps === Math.max(0, deadline.at - clock.subjectStep) &&
          expectedDeadlines.get(deadline.key) === deadline.projectedStep,
        'subject deadline projection',
      );
      keys.add(deadline.key);
    }
    requireReplay(
      [...expectedDeadlines.keys()].every((key) => keys.has(key)),
      'missing subject deadline',
    );
    if (before?.clock?.frozen && record.kind === 'interval')
      requireReplay(
        same(actor.position, before.position) &&
          same(actor.velocity, before.velocity) &&
          same(actor.facing, before.facing) &&
          actor.grounded === before.grounded,
        'frozen body motion',
      );
  }
  for (const projectile of projectiles) {
    const before = priorProjectiles?.find((value) => value.id === projectile.id),
      clock = projectile.clock;
    if (!clock) {
      requireReplay(!before?.clock, 'projectile clock removed');
      continue;
    }
    requireReplay(
      !!context.rules.experimental?.mechanics.includes('time-stop') &&
        clock.projectionAsOfGlobalStep === step &&
        !clock.frozen &&
        !clock.periods?.length &&
        clock.subjectStep === step - projectile.launchStep - clock.pausedSteps &&
        clock.deadlines.length === 1 &&
        clock.deadlines[0]!.key === 'projectile.end' &&
        clock.deadlines[0]!.domain === 'projectile' &&
        clock.deadlines[0]!.projectedStep === projectile.endStep &&
        clock.deadlines[0]!.remainingSteps === projectile.endStep - step &&
        clock.deadlines[0]!.at === clock.subjectStep + projectile.endStep - step,
      'projectile deadline projection',
    );
    if (record.kind === 'interval' && before) {
      const stopped = !!prior?.find((actor) => actor.id === before.ownerId)?.clock?.frozen;
      requireReplay(
        clock.subjectStep ===
          (before.clock?.subjectStep ?? record.fromStep - before.launchStep) + Number(!stopped) &&
          clock.pausedSteps === (before.clock?.pausedSteps ?? 0) + Number(stopped),
        'projectile owner clock advancement',
      );
      if (stopped)
        requireReplay(
          projectile.ownerId === before.ownerId &&
            same(projectile.position, before.position) &&
            same(projectile.velocity, before.velocity) &&
            record.paths
              .find((p) => p.entityId === projectile.id)
              ?.segments.every(
                (segment) =>
                  same(segment.start, before.position) && same(segment.end, before.position),
              ) === true,
          'frozen projectile motion',
        );
    }
  }
}
