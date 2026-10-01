import { domainSnapshotStep, frozen } from '../rules/subject-clocks.ts';
import type { ActorState, MotionState } from '../state.ts';
import type { BattleEvent, Effect } from '@fantasy/domain/spatial/execution';
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
import { sub, unit } from '../math.ts';
import { recordInterference } from './interference.ts';
import { readMind } from './mind-reading.ts';
import { evadeContacts } from './contact-evasion.ts';
import { cleanseSensoryCues, cognitiveCueEligibility, cueIdentity } from './sensory-cues.ts';
import { hologramIdentity, visualSensorEligibility } from './environmental-holograms.ts';
const effectEventKinds = {
  defeat: 'defeat',
  damage: 'damage',
  heal: 'heal',
  shield: 'shield',
  'apply-status': 'diagnostic',
  dispel: 'diagnostic',
  water: 'diagnostic',
  reveal: 'diagnostic',
  force: 'force',
  'sensory-cue': 'sensory-cue',
  'environmental-hologram': 'environmental-hologram',
} satisfies Record<Effect['kind'], BattleEvent['kind']>;
import type { PendingEffect } from '../state.ts';
export type { PendingEffect } from '../state.ts';
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
  effects = context.capture?.(effects) ?? effects;
  effects = context.beforeCommit?.(effects) ?? effects;
  effects = evadeContacts(actors, effects, context);
  const applications = effects.map((effect) => {
    const event = journal.emit({
      step: activationStep,
      phase,
      kind: effectEventKinds[effect.effect.kind],
      ruleId: 'effect.application',
      actorId: effect.actorId,
      targetId: effect.targetId,
      ...(effect.sourceDependentId ? { entityId: effect.sourceDependentId } : {}),
      abilityId: effect.abilityId,
      ...(effect.deferral ? { deferrals: [effect.deferral.id] } : {}),
      ...(effect.sourceActorId
        ? { sourceActorId: effect.sourceActorId, sourceProjectileId: effect.sourceProjectileId! }
        : {}),
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
        ...(frozen(a) || context.statusSteps?.has(a.body.motion.actor.participant.actorId)
          ? {
              statusStep:
                context.statusSteps?.get(a.body.motion.actor.participant.actorId) ??
                domainSnapshotStep(a, step),
            }
          : {}),
        ...(a.vitals.immortalityUsed !== undefined
          ? { immortalityUsed: a.vitals.immortalityUsed }
          : {}),
      })),
      applications,
      battle.statuses,
      step,
      activationStep,
      budget,
      deferStatuses,
      battle.rules.experimental?.mechanics.some((mechanic) =>
        ['instant-death', 'immortality', 'time-stop'].includes(mechanic),
      ) ?? false,
    );
  } catch (error) {
    recordInterference(error, context);
  }
  for (const result of resolved) {
    const actor = actors.find((a) => a.body.motion.actor.participant.actorId === result.actorId)!;
    const incoming = applications.filter((a) => a.targetId === result.actorId);
    // A control dispel cleans only cues owned by this observer. Expiry/discovery already ran at
    // the boundary; cleanse precedes same-wave emission so a newly emitted cue is not erased.
    if (
      incoming.some(
        (a) => a.effect.kind === 'dispel' && a.effect.categories?.includes('control'),
      ) &&
      actor.mind.sensoryCues.length
    ) {
      cleanseSensoryCues(
        actor,
        activationStep,
        phase,
        journal,
        incoming
          .filter((a) => a.effect.kind === 'dispel' && a.effect.categories?.includes('control'))
          .map((a) => a.id),
      );
    }
    for (const app of incoming) {
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
          : app.guards?.length
            ? 'guarded-damage-retains-contact-and-effects'
            : 'shared-shield-and-single-hp-clamp';
      } else if (app.effect.kind === 'heal') {
        app.event.amount = result.healing.find((h) => h.applicationId === app.id)!.amount;
      } else if (app.effect.kind === 'shield') {
        app.event.amount = Math.floor((app.effect.amount * (app.scaleBps ?? 10000)) / 10000);
      } else if (app.effect.kind === 'defeat') {
        app.event.defeat = result.defeats.find(
          (request) => request.applicationId === app.id,
        )!.detail;
        app.event.ruleId = 'concept.defeat';
        app.event.reason = app.event.defeat.reason;
      } else if (app.effect.kind === 'sensory-cue') {
        const eligibility = cognitiveCueEligibility(
          actor,
          context.statusSteps?.get(result.actorId) ?? domainSnapshotStep(actor, step),
        );
        if (!eligibility.eligible || actor.mind.sensoryCues.length >= 8 || !app.actorId) {
          app.event.kind = 'fizzle';
          app.event.ruleId = 'sensory-cue.eligibility';
          app.event.reason = !eligibility.eligible
            ? eligibility.reason
            : !app.actorId
              ? 'missing-creator'
              : 'observer-cue-cap';
        } else {
          const ordinal = app.event.sequence;
          const identity = cueIdentity(battle.manifest.seed, app.actorId, result.actorId, ordinal);
          const source =
            app.observation?.self.position ??
            actors.find(
              (candidate) => candidate.body.motion.actor.participant.actorId === app.actorId,
            )!.body.motion.position;
          const cue = {
            id: identity,
            creatorId: app.actorId,
            observerId: result.actorId,
            modality: 'visual' as const,
            perceivedOrigin: {
              x: source.x + app.effect.offsetMm.x / 1000,
              y: source.y + app.effect.offsetMm.y / 1000,
              z: source.z + app.effect.offsetMm.z / 1000,
            },
            emittedAt: activationStep,
            deliveredAt: activationStep + app.effect.deliverySteps,
            expiresAt: activationStep + app.effect.durationSteps,
            discoveredAt: activationStep + app.effect.discoverySteps,
            confidenceBps: app.effect.confidenceBps,
          };
          actor.mind.sensoryCues.push(cue);
          app.event.entityId = cue.id;
          app.event.ruleId = 'sensory-cue.emit';
          app.event.reason = 'bounded-observer-visual-cue';
          app.event.sensoryCue = { ...cue, transition: 'emitted' };
        }
      } else if (app.effect.kind === 'environmental-hologram') {
        const eligibility = visualSensorEligibility(
          actor,
          context.statusSteps?.get(result.actorId) ?? domainSnapshotStep(actor, step),
        );
        if (
          !eligibility.eligible ||
          actor.sensors.environmentalHolograms.length >= 8 ||
          !app.actorId ||
          !app.abilityId ||
          app.effectIndex === undefined
        ) {
          app.event.kind = 'fizzle';
          app.event.ruleId = 'environmental-hologram.eligibility';
          app.event.reason = !eligibility.eligible
            ? eligibility.reason
            : !app.actorId
              ? 'missing-creator'
              : !app.abilityId || app.effectIndex === undefined
                ? 'missing-authored-effect'
                : 'observer-hologram-cap';
        } else {
          const identity = hologramIdentity(
            battle.manifest.seed,
            app.actorId,
            result.actorId,
            app.event.sequence,
          );
          const source =
            app.observation?.self.position ??
            actors.find(
              (candidate) => candidate.body.motion.actor.participant.actorId === app.actorId,
            )!.body.motion.position;
          const hologram = {
            id: identity,
            creatorId: app.actorId,
            observerId: result.actorId,
            observerIds: [result.actorId] as [string],
            abilityId: app.abilityId,
            effectIndex: app.effectIndex,
            ...(app.stage ? { stageIndex: app.stage.stageIndex } : {}),
            modality: 'visual' as const,
            sourcePosition: { ...source },
            perceivedPosition: {
              x: source.x + app.effect.offsetMm.x / 1000,
              y: source.y + app.effect.offsetMm.y / 1000,
              z: source.z + app.effect.offsetMm.z / 1000,
            },
            state: 'active-unobserved' as const,
            activatedAt: activationStep,
            observedAt: activationStep + app.effect.observationSteps,
            invalidatedAt: activationStep + app.effect.invalidationSteps,
            expiresAt: activationStep + app.effect.durationSteps,
          };
          actor.sensors.environmentalHolograms.push(hologram);
          app.event.entityId = hologram.id;
          app.event.point = { ...source };
          app.event.ruleId = 'environmental-hologram.activated';
          app.event.reason = 'bounded-observer-visual-sensor-projection';
          app.event.environmentalHologram = { ...hologram, transition: 'activated' };
        }
      }
      const observer = actors.find((a) => a.body.motion.actor.participant.actorId === app.actorId);
      if (app.effect.kind === 'defeat' && observer)
        observer.vitals.conceptCue = { kind: 'instant-death', at: activationStep };
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
            ...(app.sourceActorId ? { sourceActorId: app.sourceActorId } : {}),
            ...(app.stage ? { stage: app.stage } : {}),
          },
          app.deferral ? activationStep - 1 : step,
          budget,
        );
        app.event.reason = Object.values(app.event.force.velocityMmPerSecond).every((n) => n === 0)
          ? 'coincident-zero-force'
          : 'contact-frozen-linear-force';
      }
      const ability =
        app.sourceAbility ??
        observer?.body.motion.actor.abilities.find((a) => a.id === app.abilityId);
      if (observer && !frozen(observer) && ability && observer !== actor) {
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
          app.effect.kind === 'reveal' && app.effect.field === 'resistance'
            ? observeReveal(
                world,
                geometry.self,
                geometry.target,
                app.effect,
                ref,
                app.id,
                activationStep,
                app.capturedVisible,
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
                    // A returned enemy payload is not self-known launch power.
                    basePower: app.sourceActorId
                      ? 0
                      : Number(
                          (damagePower(app.effect, app) *
                            BigInt(app.dealtByElement?.[app.effect.element] ?? 10000)) /
                            10000n,
                        ),
                    ...(app.effect.defense !== undefined && { defense: app.effect.defense }),
                    impact: detail.calculation?.afterModifiers ?? detail.afterResistance,
                    ...(detail.absorption && { absorbed: detail.absorption.converted }),
                    shield: BigInt(detail.absorbed.numerator) > 0n,
                    // A defended contact cannot establish permanent elemental efficacy.
                    partial:
                      !!app.sourceActorId ||
                      !!app.damageCancelled ||
                      !!app.guards?.length ||
                      (app.scaleBps ?? 10000) !== 10000,
                    statuses: actor.statuses,
                    statusStep:
                      context.statusSteps?.get(result.actorId) ?? domainSnapshotStep(actor, step),
                  },
                  activationStep,
                  battle.rules.ai,
                  app.capturedVisible,
                )
              : null;
        if (experience) observer.mind.memory = rememberExperience(observer.mind.memory, experience);
        if (app.effect.kind === 'reveal' && app.effect.field !== 'resistance') {
          const reading = readMind(
            world,
            geometry.self,
            actor,
            geometry.target,
            app.effect,
            ref,
            app.id,
            activationStep,
            app.capturedVisible,
          );
          if (reading) {
            observer.mind.memory = {
              ...observer.mind.memory,
              pendingReadings: [...(observer.mind.memory.pendingReadings ?? []), reading].slice(
                -32,
              ),
            };
            observer.vitals.conceptCue = { kind: 'mind-read', at: activationStep };
          }
          app.event.ruleId = 'concept.bounded-read';
          app.event.reason = reading
            ? 'sampled; delayed bounded observation queued'
            : 'occluded or resisted';
        }
      }
    }
    emitStatusChanges(result, journal, activationStep, phase);
    if (result.protection) {
      const use = (actor.vitals.immortalityUsed ?? 0) + 1;
      actor.vitals.immortalityUsed = use;
      actor.vitals.conceptCue = { kind: 'immortality', at: activationStep };
      journal.emit({
        kind: 'immortality',
        step: activationStep,
        phase,
        actorId: result.actorId,
        targetId: result.actorId,
        ruleId: 'concept.immortality',
        before: { ...actor.vitals.resources },
        after: { ...result.resources },
        causes: applications
          .filter((application) => application.targetId === result.actorId)
          .map((application) => application.id),
        immortality: {
          use,
          status: {
            id: result.protection.id,
            revision: result.protection.revision,
            contentHash: result.protection.contentHash,
          },
        },
        reason: 'finite-opening-protection; least-simultaneous-drain-fixed-point',
        ...(deferStatuses ? { wave: waveIndex } : {}),
      });
    }
    if (!deferStatuses) rememberApplications(actor, result.changes, applications, context);
    actor.vitals.resources = result.resources;
    actor.statuses = result.statuses;
  }
  for (const application of applications) {
    if (!application.drainRecipientId) continue;
    const detail = resolved
      .flatMap((result) => result.damage)
      .find((damage) => damage.applicationId === application.id);
    if (!detail?.drain) continue;
    const dependent = context.dependents?.find(
      (candidate) => candidate.id === application.drainRecipientId,
    );
    if (!dependent) throw new Error('Missing dependent drain recipient');
    dependent.hp = Math.min(dependent.maxHp, dependent.hp + detail.drain.healing);
  }
  for (const result of resolved) {
    for (const detail of result.damage) {
      if (!detail.drain?.healing) continue;
      const app = applications.find((a) => a.id === detail.applicationId)!;
      const source = resolved.find((r) => r.actorId === app.actorId)!;
      journal.emit({
        step: activationStep,
        phase,
        kind: 'heal',
        ruleId: 'damage.drain',
        actorId: app.actorId,
        targetId: app.actorId,
        ...(app.drainRecipientId ? { entityId: app.drainRecipientId } : {}),
        abilityId: app.abilityId,
        parentEventId: app.id,
        causes: [app.id],
        amount: detail.drain.healing,
        ...(app.drainRecipientId ? {} : { after: { ...source.resources } }),
        reason: app.drainRecipientId
          ? 'same-wave-hp-loss-dependent-drain'
          : 'same-wave-hp-loss-drain',
        ...(deferStatuses ? { wave: waveIndex } : {}),
      });
    }
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
    if (frozen(actor)) continue;
    const id = actor.body.motion.actor.participant.actorId;
    const incoming = applications.filter((a) => a.targetId === id);
    try {
      let plan: ReturnType<typeof planStatusEffects>;
      try {
        plan = planStatusEffects(
          actor.statuses,
          incoming,
          battle.statuses,
          context.statusSteps?.get(id) ?? step,
        );
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
