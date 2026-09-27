import type { StopReplay } from '../clocks.ts';
import type { BattleEvent, DeferredEffect } from '../records.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import { requireReplay, same } from './common.ts';

/** Bounded causal receipts survive checkpoints after a projectile has been consumed. */
export function deferredReceipts(
  previous: readonly DeferredEffect[] | undefined,
  events: readonly BattleEvent[],
) {
  return [...(previous ?? []), ...events.flatMap((event) => event.timeStop?.captured ?? [])];
}
export function advanceDeferred(
  previous: readonly DeferredEffect[] | undefined,
  events: readonly BattleEvent[],
) {
  const receipts = deferredReceipts(previous, events);
  if (!previous && !receipts.length) return undefined;
  requireReplay(
    receipts.length <= 4096 &&
      new Set(receipts.map((receipt) => receipt.id)).size === receipts.length,
    'deferred receipt identity/cap',
  );
  const consumed = events.flatMap((event) => event.deferrals ?? []);
  requireReplay(new Set(consumed).size === consumed.length, 'duplicate deferred settlement');
  for (const event of events)
    for (const id of event.deferrals ?? []) {
      const receipt = receipts.find((candidate) => candidate.id === id);
      requireReplay(
        !!receipt &&
          receipt.capturedAt <= event.step &&
          (event.evasion
            ? event.actorId === receipt.targetId && event.targetId === receipt.actorId
            : event.actorId === receipt.actorId &&
              event.targetId === receipt.targetId &&
              event.abilityId === receipt.abilityId),
        'deferred settlement identity',
      );
    }
  const released = new Set(
    events
      .filter((event) => event.timeStop?.state === 'release')
      .map((event) => event.timeStop!.controlId),
  );
  requireReplay(
    receipts.every((receipt) => released.has(receipt.controlId) === consumed.includes(receipt.id)),
    'deferred release completeness',
  );
  return receipts.filter((receipt) => !released.has(receipt.controlId));
}

export function advanceStopReplay(
  previous: StopReplay | undefined,
  events: readonly BattleEvent[],
) {
  const relevant = events.filter((event) => event.timeStop);
  if (!previous && !relevant.length) return undefined;
  const state = previous
    ? structuredClone(previous)
    : ({ controls: [], contacts: 0, operations: 0, bytes: 0 } as StopReplay);
  for (const event of relevant) {
    const stop = event.timeStop!,
      active = state.controls.find((control) => control.releasedAt === undefined);
    if (stop.state === 'activated') {
      requireReplay(
        !active &&
          !state.controls.some((control) => control.id === stop.controlId) &&
          state.controls.length < 4,
        'stop activation identity',
      );
      state.controls.push({
        id: stop.controlId,
        ownerId: event.actorId!,
        targetId: event.targetId!,
        from: event.step,
        until: event.step + stop.durationSteps,
        operations: 0,
      });
    } else if (stop.state === 'capture' || stop.state === 'release') {
      requireReplay(
        !!active &&
          active.id === stop.controlId &&
          active.ownerId === event.actorId &&
          active.targetId === event.targetId &&
          event.step >= active.from &&
          event.step <= active.until,
        'stop active transition',
      );
      if (stop.state === 'release') active!.releasedAt = event.step;
      else {
        const captured = stop.captured ?? [];
        requireReplay(
          captured.length > 0 &&
            captured.every((receipt, i) => receipt.id === `deferred.${state.operations + i}`) &&
            stop.contacts > state.contacts &&
            stop.contacts - state.contacts <= captured.length &&
            stop.bytes > state.bytes,
          'stop capture accounting',
        );
        state.contacts = stop.contacts;
        state.operations += captured.length;
        active!.operations += captured.length;
        state.bytes = stop.bytes;
      }
    }
    requireReplay(
      stop.uses === state.controls.length &&
        stop.reservedSteps === state.controls.reduce((n, c) => n + c.until - c.from, 0) &&
        stop.executedSteps ===
          state.controls.reduce(
            (n, c) => n + (c.releasedAt === undefined ? 0 : c.releasedAt - c.from),
            0,
          ) &&
        stop.contacts === state.contacts &&
        stop.operations === state.operations &&
        stop.bytes === state.bytes,
      'stop cumulative accounting',
    );
  }
  return state;
}

/** Checkpoint integrity uses the recorded control ledger, never combat re-simulation. */
export function validateStopCheckpoint(checkpoint: ReplayCheckpoint) {
  const { stop, deferred = [], state, step, requiredFeatures } = checkpoint;
  if (!stop) {
    requireReplay(
      !deferred.length && !state?.actors.some((a) => a.clock),
      'missing stop checkpoint ledger',
    );
    return;
  }
  requireReplay(
    requiredFeatures?.includes('subject-clocks-v1') === true &&
      requiredFeatures.includes('deferred-contacts-v1'),
    'missing checkpoint stop features',
  );
  requireReplay(
    new Set(stop.controls.map((c) => c.id)).size === stop.controls.length &&
      stop.controls.filter((c) => c.releasedAt === undefined).length <= 1 &&
      stop.operations === stop.controls.reduce((n, c) => n + c.operations, 0),
    'checkpoint stop accounting',
  );
  let previousEnd = 0,
    reserved = 0,
    ordinal = 0;
  for (const control of stop.controls) {
    requireReplay(
      control.from >= previousEnd &&
        control.from <= step &&
        control.until > control.from &&
        control.until - control.from <= 100 &&
        (control.releasedAt === undefined
          ? step <= control.until
          : control.releasedAt >= control.from &&
            control.releasedAt <= Math.min(step, control.until)) &&
        control.ownerId !== control.targetId &&
        !!state?.actors.some((a) => a.id === control.ownerId) &&
        !!state?.actors.some((a) => a.id === control.targetId),
      'checkpoint control binding',
    );
    previousEnd = control.releasedAt ?? step;
    reserved += control.until - control.from;
    const receipts = deferred.filter((r) => r.controlId === control.id);
    requireReplay(
      control.releasedAt === undefined
        ? receipts.length === control.operations &&
            receipts.every(
              (r, i) =>
                r.id === `deferred.${ordinal + i}` &&
                r.targetId === control.targetId &&
                r.actorId !== r.targetId &&
                r.capturedAt >= control.from &&
                r.capturedAt <= step,
            )
        : !receipts.length,
      'missing/invalid checkpoint descriptor',
    );
    ordinal += control.operations;
  }
  requireReplay(
    reserved <= 300 && deferred.every((r) => stop.controls.some((c) => c.id === r.controlId)),
    'checkpoint stop budget/receipt',
  );
  for (const actor of state?.actors ?? []) {
    const controls = stop.controls.filter((c) => c.targetId === actor.id);
    if (!controls.length) {
      requireReplay(!actor.clock, 'unbound checkpoint clock');
      continue;
    }
    const active = controls.find((c) => c.releasedAt === undefined);
    requireReplay(
      !!actor.clock &&
        same(
          actor.clock.periods ?? [],
          controls
            .filter((c) => c.releasedAt !== undefined)
            .map((c) => ({ from: c.from, to: c.releasedAt })),
        ) &&
        same(
          actor.clock.frozen ?? null,
          active ? { controlId: active.id, from: active.from, until: active.until } : null,
        ),
      'checkpoint clock/control binding',
    );
  }
}
