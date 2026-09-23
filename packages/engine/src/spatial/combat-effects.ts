import type { BattleEvent, Budget, DeepReadonly, Effect } from '@fantasy/domain/spatial';
import { resolveEffects } from './effects.ts';
import { damagePower } from './damage.ts';
import type { DamageSnapshot } from './status-damage.ts';
import type { ActorState } from './combat-state.ts';
import type { PreparedBattle } from './prepare.ts';
import type { Journal } from './journal.ts';
import { observeImpact, observeReveal, rememberExperience } from './perception.ts';
import { at, type SpatialWorld } from './physics.ts';
import type { MotionState, MovedActor } from './movement.ts';
const effectEventKinds = {
  damage: 'damage',
  heal: 'heal',
  shield: 'shield',
  'apply-status': 'diagnostic',
  dispel: 'diagnostic',
  water: 'diagnostic',
  reveal: 'diagnostic',
} satisfies Record<Effect['kind'], BattleEvent['kind']>;
export type PendingEffect = DamageSnapshot & {
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  parentEventId: string | null;
  abilityId: string | null;
  causes?: readonly string[];
  scaleBps?: number;
  observation?: { self: MotionState; target: MotionState };
};
/** Keep the contact geometry even though simultaneous effects commit after movement. */
export function contactObservation(
  moved: readonly MovedActor[],
  self: MotionState,
  target: MotionState,
  time: number,
): NonNullable<PendingEffect['observation']> {
  const motion = (initial: MotionState) => {
    const actor = moved.find(
      (a) => a.state.actor.participant.actorId === initial.actor.participant.actorId,
    );
    if (!actor) throw new Error('Missing contact participant');
    // Rotation is committed at the interval boundary; never borrow its future facing.
    return { ...initial, position: at(actor.trace, time) };
  };
  return { self: motion(self), target: motion(target) };
}
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
        app.event.amount = detail.calculation?.afterModifiers ?? detail.afterResistance;
        app.event.ruleId = 'damage.defense-resistance-shield';
        app.event.reason = 'shared-shield-and-single-hp-clamp';
      } else if (app.effect.kind === 'heal') {
        app.event.amount = result.healing.find((h) => h.applicationId === app.id)!.amount;
      } else if (app.effect.kind === 'shield') {
        app.event.amount = Math.floor((app.effect.amount * (app.scaleBps ?? 10000)) / 10000);
      }
      const observer = actors.find((a) => a.motion.actor.participant.actorId === app.actorId);
      const ability = observer?.motion.actor.abilities.find((a) => a.id === app.abilityId);
      if (observer && ability && observer !== actor) {
        const geometry = app.observation ?? { self: observer.motion, target: actor.motion };
        const ref = {
          id: ability.id,
          revision: ability.revision,
          contentHash: ability.contentHash,
        };
        const experience =
          app.effect.kind === 'reveal'
            ? observeReveal(
                world,
                geometry.self,
                geometry.target,
                app.effect,
                ref,
                app.id,
                activationStep,
              )
            : app.effect.kind === 'damage' && detail
              ? observeImpact(
                  world,
                  geometry.self,
                  geometry.target,
                  {
                    ability: ref,
                    eventId: app.id,
                    element: app.effect.element,
                    basePower: Number(
                      (damagePower(app.effect, app) *
                        BigInt(app.dealtByElement?.[app.effect.element] ?? 10000)) /
                        10000n,
                    ),
                    ...(app.effect.defense !== undefined && { defense: app.effect.defense }),
                    impact: detail.calculation?.afterModifiers ?? detail.afterResistance,
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
    for (const reaction of result.reactions)
      journal.emit({
        step: activationStep,
        phase,
        kind: 'diagnostic',
        targetId: result.actorId,
        causes: reaction.causes,
        ruleId: 'status.reaction',
        amount: reaction.multiplier,
        reason: `${reaction.statusId}:${reaction.element}:${reaction.response}`,
      });
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
