import { abilityEffects } from '../contracts.ts';
import type { BattleEvent, DeferredEffect } from '../records.ts';
import type { ActorDisplay, StreamRecord } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import type { ClockDisplay } from '../clocks.ts';
import { requireReplay, same, emittedId } from './common.ts';

export function validateDeferredDefinition(context: ReplayContext, receipt: DeferredEffect) {
  const source = context.actors.find(
    (actor) => actor.participant.actorId === (receipt.sourceActorId ?? receipt.actorId),
  );
  const ability = source?.abilities.find((a) => a.id === receipt.abilityId);
  requireReplay(
    !!ability &&
      context.actors.some((actor) => actor.participant.actorId === receipt.targetId) &&
      abilityEffects(ability.definition).some((effect) => same(effect, receipt.effect)),
    'deferred effect definition',
  );
}

export function validateConceptEvent(
  context: ReplayContext,
  event: BattleEvent,
  clock?: ClockDisplay,
) {
  if (event.timeStop) {
    const ability = context.actors
      .find((actor) => actor.participant.actorId === event.actorId)
      ?.abilities.find((candidate) => candidate.id === event.abilityId);
    requireReplay(
      !!context.rules.experimental?.mechanics.includes('time-stop') &&
        ability?.definition.timeStop?.durationSteps === event.timeStop.durationSteps &&
        event.ruleId === `concept.time-stop.${event.timeStop.state}`,
      'time stop definition',
    );
  }
  if (event.cognition?.kind === 'knowledge' && event.cognition.readings) {
    for (const reading of event.cognition.readings) {
      const source = context.actors.find((actor) => actor.participant.actorId === event.actorId);
      const ability = source?.abilities.find((candidate) =>
        same(reading.ability, {
          id: candidate.id,
          revision: candidate.revision,
          contentHash: candidate.contentHash,
        }),
      );
      const target = context.actors.find((actor) => actor.participant.actorId === reading.targetId);
      const matches =
        ability &&
        abilityEffects(ability.definition).some((spec) => {
          if (spec.kind !== 'reveal' || spec.field !== reading.field) return false;
          let availableAt =
              reading.sampledAt + spec.delaySteps + source!.character.perception.reactionSteps,
            expiresAt = reading.sampledAt + spec.durationSteps;
          for (const period of clock?.periods ?? []) {
            if (period.from < reading.sampledAt) continue;
            if (availableAt >= period.from) availableAt += period.to - period.from;
            expiresAt += period.to - period.from;
          }
          return (
            reading.availableAt === availableAt &&
            reading.expiresAt === expiresAt &&
            (reading.field !== 'health' ||
              (spec.field === 'health' &&
                reading.range.low % spec.precisionBps === 0 &&
                reading.range.high === Math.min(10000, reading.range.low + spec.precisionBps)))
          );
        });
      requireReplay(
        !!context.rules.experimental?.mechanics.includes('mind-read') &&
          !!matches &&
          !!source &&
          !!target &&
          emittedId(reading.eventId) < emittedId(event.id) &&
          (reading.field !== 'declared-action' ||
            reading.action === null ||
            target.abilities.some(
              (candidate) =>
                candidate.id === reading.action?.abilityId &&
                candidate.definition.trigger === 'action',
            )) &&
          reading.targetId !== event.actorId &&
          !clock?.frozen &&
          reading.sampledAt <= event.step &&
          event.step >= reading.availableAt &&
          event.step < reading.expiresAt,
        'bounded delayed mind reading',
      );
    }
  }
  if (event.evasion)
    requireReplay(
      !!context.rules.experimental?.mechanics.includes('absolute-evasion') &&
        event.ruleId === 'concept.contact-evasion' &&
        event.evasion.statuses.every((ref) =>
          context.manifest.revisions.some(
            (revision) =>
              revision.kind === 'status' &&
              !!revision.definition.evasion &&
              same(ref, {
                id: revision.id,
                revision: revision.revision,
                contentHash: revision.contentHash,
              }),
          ),
        ),
      'contact evasion definition',
    );
  if (event.defeat) {
    const source = context.actors.find(
      (actor) => actor.participant.actorId === (event.sourceActorId ?? event.actorId),
    );
    const ability = source?.abilities.find((revision) => revision.id === event.abilityId);
    requireReplay(
      !!context.rules.experimental?.mechanics.includes('instant-death') &&
        ability?.definition.trigger === 'action' &&
        abilityEffects(ability.definition).some((effect) => effect.kind === 'defeat') &&
        event.ruleId === 'concept.defeat' &&
        event.actorId !== event.targetId &&
        !!event.before &&
        !!event.after &&
        !event.damage &&
        event.amount === null,
      'defeat contact definition',
    );
  }
  if (event.immortality) {
    const status = context.manifest.revisions.find(
      (revision) =>
        revision.kind === 'status' &&
        same(
          { id: revision.id, revision: revision.revision, contentHash: revision.contentHash },
          event.immortality!.status,
        ),
    );
    requireReplay(
      !!context.rules.experimental?.mechanics.includes('immortality') &&
        status?.kind === 'status' &&
        !!status.definition.immortality &&
        event.immortality.use <= status.definition.immortality.protections &&
        event.ruleId === 'concept.immortality' &&
        event.before!.hp > 0 &&
        event.after!.hp === 1,
      'immortality definition and finite use',
    );
  }
}

/** Preserve cumulative uses across expiration, regrant, suppression and revival. */
export function validateImmortalityCounts(
  prior: readonly ActorDisplay[] | undefined,
  actors: readonly ActorDisplay[],
  record: StreamRecord,
) {
  for (const actor of actors) {
    const old = prior?.find((previous) => previous.id === actor.id)?.immortalityUsed;
    const events =
      'events' in record
        ? record.events.filter((event) => event.immortality && event.actorId === actor.id)
        : [];
    if (old === undefined && actor.immortalityUsed === undefined && !events.length) continue;
    requireReplay(
      actor.immortalityUsed === (old ?? 0) + events.length &&
        events.every((event, index) => event.immortality!.use === (old ?? 0) + index + 1),
      'immortality cumulative count',
    );
    const last = events.at(-1);
    if (last && 'events' in record) {
      const later = record.events.filter(
        (event) =>
          event.sequence > last.sequence &&
          (event.targetId === actor.id || event.actorId === actor.id) &&
          event.after,
      );
      requireReplay(
        actor.resources.hp === (later.at(-1)?.after?.hp ?? last.after!.hp),
        'immortality displayed HP',
      );
    }
  }
}
