import type { BattleEvent, Budget, DeepReadonly, Effect } from '@fantasy/domain/spatial';
import { resolveEffects } from './effects.ts';
import type { ActorState } from './combat-state.ts';
import type { PreparedBattle } from './prepare.ts';
import type { Journal } from './journal.ts';
export type PendingEffect = {
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  attack: number;
  parentEventId: string | null;
  abilityId: string | null;
  causes?: readonly string[];
  scaleBps?: number;
};
/** Emit causal applications, then commit every target from the same defense/status snapshot. */
export function commitEffects(
  actors: ActorState[],
  effects: PendingEffect[],
  battle: PreparedBattle,
  journal: Journal,
  step: number,
  activationStep: number,
  phase: BattleEvent['phase'],
  budget: Budget,
) {
  const applications = effects.map((effect) => {
    const event = journal.emit({
      step: activationStep,
      phase,
      kind:
        effect.effect.kind === 'apply-status' || effect.effect.kind === 'dispel'
          ? 'diagnostic'
          : effect.effect.kind,
      ruleId: 'effect.application',
      actorId: effect.actorId,
      targetId: effect.targetId,
      abilityId: effect.abilityId,
      parentEventId: effect.parentEventId,
      causes: [...(effect.causes ?? [])],
      reason: effect.effect.kind,
    });
    return { ...effect, id: event.id, event };
  });
  const resolved = resolveEffects(
    actors.map((a) => ({ actor: a.motion.actor, resources: a.resources, statuses: a.statuses })),
    applications,
    battle.statuses,
    step,
    activationStep,
    budget,
  );
  for (const result of resolved) {
    const actor = actors.find((a) => a.motion.actor.participant.actorId === result.actorId)!;
    for (const app of applications.filter((a) => a.targetId === result.actorId)) {
      app.event.before = { ...actor.resources };
      app.event.after = { ...result.resources };
      const detail = result.damage.find((d) => d.applicationId === app.id);
      if (detail) {
        const { applicationId: _, ...damage } = detail;
        app.event.damage = damage;
        app.event.amount = detail.afterResistance;
        app.event.ruleId = 'damage.defense-resistance-shield';
        app.event.reason = 'shared-shield-and-single-hp-clamp';
      } else if (app.effect.kind === 'heal' || app.effect.kind === 'shield') {
        app.event.amount = Math.floor((app.effect.amount * (app.scaleBps ?? 10000)) / 10000);
      }
    }
    for (const change of result.changes)
      journal.emit({
        step: activationStep,
        phase,
        kind:
          change.kind === 'remove'
            ? 'status-remove'
            : change.kind === 'reject'
              ? 'diagnostic'
              : 'status-apply',
        actorId: result.actorId,
        targetId: result.actorId,
        causes: [...change.causes],
        ruleId: `status.${change.kind}`,
        amount: change.stacks,
        reason: `${change.revision.id}:${change.reason}`,
      });
    actor.resources = result.resources;
    actor.statuses = result.statuses;
  }
}
