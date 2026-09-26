import type { DamageSnapshot, ActorState, MotionState } from '../state.ts';
import type {
  BattleEvent,
  DeepReadonly,
  Effect,
  StageContact,
  ReactionContext,
} from '@fantasy/domain/spatial/execution';
import { resolveEffects } from '../rules/effects.ts';
import { damagePower } from '../rules/damage.ts';
import type { Journal } from '../rules/journal.ts';
import { observeImpact, observeReveal, rememberExperience } from '../ai/perception.ts';
import { at } from '../world/physics.ts';
import type { MovedActor } from '../world/movement.ts';
import { queueForce } from '../rules/forces.ts';
import { planStatusEffects } from '../rules/status-reactions.ts';
import { applyStatuses, UnresolvedRuleError } from '../rules/status.ts';
import type { EffectApplication } from '../rules/effects.ts';
import { rememberThreat } from '../ai/threat-memory.ts';
import { sub, unit, type Vec3 } from '../math.ts';
import { recordInterference } from './interference.ts';
const effectEventKinds = {
  damage: 'damage',
  heal: 'heal',
  shield: 'shield',
  'apply-status': 'diagnostic',
  dispel: 'diagnostic',
  water: 'diagnostic',
  reveal: 'diagnostic',
  force: 'force',
} satisfies Record<Effect['kind'], BattleEvent['kind']>;
export type PendingEffect = DamageSnapshot & {
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  parentEventId: string | null;
  abilityId: string | null;
  causes?: readonly string[];
  scaleBps?: number;
  stage?: StageContact;
  reaction?: ReactionContext;
  damageCancelled?: boolean;
  observation?: { self: MotionState; target: MotionState };
  incomingDirection?: Vec3;
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
import type { EffectContext } from './effect-context.ts';
export type { EffectContext } from './effect-context.ts';
/** Emit causal applications, then commit every target from the same defense/status snapshot. */
export function commitEffects(
  actors: ActorState[],
  effects: PendingEffect[],
  context: EffectContext,
  deferStatuses = false,
  waveIndex = 0,
) {
  const { battle, journal, step, activationStep, phase, budget, world } = context;
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
      ...(effect.stage ? { stage: effect.stage } : {}),
      ...(effect.reaction ? { reaction: effect.reaction } : {}),
      ...(deferStatuses ? { wave: waveIndex } : {}),
    });
    return { ...effect, id: event.id, event };
  });
  let resolved: ReturnType<typeof resolveEffects>;
  try {
    resolved = resolveEffects(
      actors.map((a) => ({
        actor: a.body.motion.actor,
        resources: a.vitals.resources,
        statuses: a.statuses,
      })),
      applications,
      battle.statuses,
      step,
      activationStep,
      budget,
      deferStatuses,
    );
  } catch (error) {
    recordInterference(error, context);
  }
  for (const result of resolved) {
    const actor = actors.find((a) => a.body.motion.actor.participant.actorId === result.actorId)!;
    for (const app of applications.filter((a) => a.targetId === result.actorId)) {
      app.event.before = { ...actor.vitals.resources };
      app.event.after = { ...result.resources };
      const detail = result.damage.find((d) => d.applicationId === app.id);
      if (detail) {
        const { applicationId: _, ...damage } = detail;
        app.event.damage = damage;
        app.event.amount = detail.calculation?.afterModifiers ?? detail.afterResistance;
        app.event.ruleId = 'damage.defense-resistance-shield';
        app.event.reason = app.damageCancelled
          ? 'parried-damage-retains-element-contact'
          : 'shared-shield-and-single-hp-clamp';
      } else if (app.effect.kind === 'heal') {
        app.event.amount = result.healing.find((h) => h.applicationId === app.id)!.amount;
      } else if (app.effect.kind === 'shield') {
        app.event.amount = Math.floor((app.effect.amount * (app.scaleBps ?? 10000)) / 10000);
      }
      const observer = actors.find((a) => a.body.motion.actor.participant.actorId === app.actorId);
      if (
        app.effect.kind === 'damage' &&
        detail &&
        observer &&
        observer !== actor &&
        actor.mind.memory.search
      ) {
        const direction =
          app.incomingDirection ??
          unit(
            sub(
              app.observation?.self.position ?? observer.body.motion.position,
              app.observation?.target.position ?? actor.body.motion.position,
            ),
          );
        actor.mind.memory = {
          ...actor.mind.memory,
          search: {
            ...actor.mind.memory.search,
            cues: [
              ...actor.mind.memory.search.cues,
              {
                id: app.id,
                sampledAt: activationStep,
                availableAt:
                  activationStep + actor.body.motion.actor.character.perception.reactionSteps,
                origin: { ...actor.body.motion.position },
                direction: { ...direction },
              },
            ].slice(-8),
          },
        };
      }
      if (app.effect.kind === 'force') {
        const geometry = app.observation ?? {
          self: observer?.body.motion ?? actor.body.motion,
          target: actor.body.motion,
        };
        app.event.force = queueForce(
          actor,
          app.effect,
          geometry.self.position,
          geometry.target.position,
          {
            id: app.id,
            actorId: app.actorId,
            abilityId: app.abilityId,
            ...(app.stage ? { stage: app.stage } : {}),
          },
          step,
          budget,
        );
        app.event.reason = Object.values(app.event.force.velocityMmPerSecond).every((n) => n === 0)
          ? 'coincident-zero-force'
          : 'contact-frozen-linear-force';
      }
      const ability = observer?.body.motion.actor.abilities.find((a) => a.id === app.abilityId);
      if (observer && ability && observer !== actor) {
        const geometry = app.observation ?? {
          self: observer.body.motion,
          target: actor.body.motion,
        };
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
                    // A defended contact cannot establish permanent elemental efficacy.
                    partial: !!app.damageCancelled || (app.scaleBps ?? 10000) !== 10000,
                    statuses: actor.statuses,
                    statusStep: step,
                  },
                  activationStep,
                  battle.rules.ai,
                )
              : null;
        if (experience) observer.mind.memory = rememberExperience(observer.mind.memory, experience);
      }
    }
    emitStatusChanges(result, journal, activationStep, phase);
    if (!deferStatuses) rememberApplications(actor, result.changes, applications, context);
    actor.vitals.resources = result.resources;
    actor.statuses = result.statuses;
  }
  return { applications, resolved };
}
function emitStatusChanges(
  result: Pick<ReturnType<typeof resolveEffects>[number], 'actorId' | 'changes' | 'reactions'>,
  journal: Journal,
  activationStep: number,
  phase: BattleEvent['phase'],
) {
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
}
/** One old-cohort plan for the union of accepted applications across every wave. */
export function commitTransactionStatuses(
  actors: ActorState[],
  applications: readonly EffectApplication[],
  context: EffectContext,
) {
  const { battle, journal, step, activationStep, phase, budget } = context;
  for (const actor of actors) {
    const id = actor.body.motion.actor.participant.actorId;
    const incoming = applications.filter((a) => a.targetId === id);
    try {
      let plan: ReturnType<typeof planStatusEffects>;
      try {
        plan = planStatusEffects(actor.statuses, incoming, battle.statuses, step);
      } catch (error) {
        if (!(error instanceof UnresolvedRuleError)) throw error;
        throw new UnresolvedRuleError(
          error.ruleId,
          error.revisions,
          `${error.message}; point=status-commit; step=${activationStep}; actor=${id}; causes=${incoming
            .slice(0, 8)
            .map((a) => a.id)
            .join(',')}; total=${incoming.length}`,
          error.detail,
        );
      }
      const applied = applyStatuses(
        plan.statuses,
        plan.applications,
        plan.dispels,
        activationStep,
        budget,
      );
      emitStatusChanges(
        { actorId: id, reactions: plan.traces, changes: [...plan.changes, ...applied.changes] },
        journal,
        activationStep,
        phase,
      );
      rememberApplications(actor, applied.changes, incoming, context);
      actor.statuses = applied.statuses;
    } catch (error) {
      recordInterference(error, { ...context, interferencePoint: 'status-commit' }, id);
    }
  }
}

function rememberApplications(
  actor: ActorState,
  changes: ReturnType<typeof applyStatuses>['changes'],
  incoming: readonly EffectApplication[],
  { battle, activationStep }: EffectContext,
) {
  if (!battle.rules.ai.reapplication) return;
  for (const change of changes) {
    if (change.kind !== 'apply' && change.kind !== 'refresh') continue;
    const cause = incoming.find(
      (e) =>
        e.actorId &&
        e.actorId !== actor.body.motion.actor.participant.actorId &&
        change.causes.includes(e.id),
    );
    if (!cause?.actorId) continue;
    const elemental = incoming.find(
      (e) =>
        e.actorId === cause.actorId &&
        e.abilityId === cause.abilityId &&
        !!cause.parentEventId &&
        e.parentEventId === cause.parentEventId &&
        e.effect.kind === 'damage',
    );
    const element =
      elemental?.effect.kind === 'damage'
        ? elemental.effect.element
        : change.revision.definition.periodic.flatMap((p) =>
            p.kind === 'damage' ? [p.element] : [],
          )[0];
    actor.mind.memory = rememberThreat(actor.mind.memory, {
      eventId: cause.id,
      sourceId: cause.actorId,
      statusId: change.revision.id,
      ...(element ? { element } : {}),
      sampledAt: activationStep,
      availableAt: activationStep + actor.body.motion.actor.character.perception.reactionSteps,
      expiresAt: activationStep + battle.rules.ai.knowledgeTtlSteps,
    });
  }
}
