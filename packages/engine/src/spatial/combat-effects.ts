import type { BattleEvent, Budget, DeepReadonly, Effect } from '@fantasy/domain/spatial';
import { resolveEffects } from './effects.ts';
import type { ActorState } from './combat-state.ts';
import type { PreparedBattle } from './prepare.ts';
import type { Journal } from './journal.ts';
import { observeImpact, observeReveal, rememberExperience } from './perception.ts';
import type { SpatialWorld } from './physics.ts';
const effectEventKinds = {
  damage: 'damage',
  heal: 'heal',
  shield: 'shield',
  'apply-status': 'diagnostic',
  dispel: 'diagnostic',
  water: 'diagnostic',
  reveal: 'diagnostic',
} satisfies Record<Effect['kind'], BattleEvent['kind']>;
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
  world: SpatialWorld,
) {
  const applications = effects.map((effect) => {
    const event = journal.emit({
      step: activationStep,
      phase,
      kind: effectEventKinds[effect.effect.kind],
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
      const observer = actors.find((a) => a.motion.actor.participant.actorId === app.actorId);
      const ability = observer?.motion.actor.abilities.find((a) => a.id === app.abilityId);
      if (observer && ability && observer !== actor) {
        const ref = {
          id: ability.id,
          revision: ability.revision,
          contentHash: ability.contentHash,
        };
        const experience =
          app.effect.kind === 'reveal'
            ? observeReveal(
                world,
                observer.motion,
                actor.motion,
                app.effect,
                ref,
                app.id,
                activationStep,
              )
            : app.effect.kind === 'damage' && detail
              ? observeImpact(
                  world,
                  observer.motion,
                  actor.motion,
                  {
                    ability: ref,
                    eventId: app.id,
                    element: app.effect.element,
                    basePower:
                      app.effect.amount +
                      Math.floor((app.attack * app.effect.attackScaleBps) / 10000),
                    impact: detail.afterResistance,
                    shield: BigInt(detail.absorbed.numerator) > 0n,
                    partial: (app.scaleBps ?? 10000) !== 10000,
                  },
                  activationStep,
                  battle.rules.ai,
                )
              : null;
        if (experience) observer.memory = rememberExperience(observer.memory, experience);
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
