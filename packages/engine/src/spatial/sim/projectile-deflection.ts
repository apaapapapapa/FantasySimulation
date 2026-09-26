import type { DisplayPath, ProjectileDeflection } from '@fantasy/domain/spatial/execution';
import type { ActorState } from '../state.ts';
import { projectileVelocityAt, type ProjectileState } from '../rules/projectiles.ts';
import { copyDamageSnapshot } from '../rules/status-damage.ts';
import { SpatialBudgetError } from '../world/physics.ts';
import { length, mul, sub, unit } from '../math.ts';
import type { PendingEffect, EffectContext } from './combat-effects.ts';
import {
  impactEffects,
  removeImpact,
  type ProjectileImpact,
  type ProjectileImpactContext,
} from './projectile-impact.ts';
import {
  reactionCandidates,
  reactionAffordable,
  type ActivatedReaction,
} from './reaction-activation.ts';

/** Contact replacement stays in the enclosing transaction. Previewing never pays
 * a cost, consumes a hit, emits a blast, or changes ownership. */
export class ProjectileContacts {
  private readonly impacts: {
    impact: ProjectileImpact;
    preview: PendingEffect[];
    direct: PendingEffect[];
  }[] = [];
  private readonly context: ProjectileImpactContext;
  private readonly alive: ProjectileState[];
  private readonly paths: DisplayPath[];
  constructor(context: ProjectileImpactContext, alive: ProjectileState[], paths: DisplayPath[]) {
    this.context = context;
    this.alive = alive;
    this.paths = paths;
  }
  add(impact: ProjectileImpact) {
    const { projectile, enemy } = impact;
    const targetId = enemy.state.actor.participant.actorId;
    const admission = projectile.stage
      ? this.context.ledger.contact(projectile.stage, projectile.hit, targetId, this.context.step)
      : null;
    impact.bodyAdmission = admission;
    const direct: PendingEffect[] =
      admission?.accepted === false
        ? []
        : projectile.ability.definition.effects.map((effect) => ({
            actorId: projectile.ownerId,
            targetId,
            effect,
            ...copyDamageSnapshot(projectile),
            sourceAbility: projectile.ability,
            abilityId: projectile.ability.id,
            parentEventId: impact.impact.id,
            projectileContact: {
              id: projectile.id,
              direct: true,
              reflected: !!projectile.deflection,
            },
            ...(projectile.deflection ? { ancestry: deepest(projectile.deflection).context } : {}),
          }));
    this.impacts.push({
      impact,
      direct,
      preview: impactEffects(impact, this.context, false, true),
    });
  }
  private inputs(base: PendingEffect[], deflected: ReadonlySet<string>) {
    return [
      ...base,
      ...this.impacts.flatMap(({ impact, direct, preview }) => [
        ...direct,
        ...preview.filter(
          (app) =>
            app.targetId !== impact.enemy.state.actor.participant.actorId &&
            !deflected.has(impact.projectile.id),
        ),
      ]),
    ];
  }
  plan(base: PendingEffect[], actors: ActorState[], context: EffectContext) {
    const deflected = new Set<string>();
    // Removing a replaced explosion can only release another owner's grouped cost.
    // Each owner becomes affordable at most once; no ID/registration precedence.
    for (let pass = 0; pass <= actors.length; pass++) {
      const before = deflected.size;
      const inputs = this.inputs(base, deflected);
      for (const actor of actors) {
        if (
          context.aliveAtStart &&
          !context.aliveAtStart.has(actor.body.motion.actor.participant.actorId)
        )
          continue;
        const candidates = reactionCandidates(actor, actors, inputs, 'before-hit', context);
        if (!reactionAffordable(actor, candidates, context)) continue;
        for (const candidate of candidates)
          if (candidate.ability.definition.reaction!.response.kind === 'deflect')
            for (const app of candidate.matches) deflected.add(app.projectileContact!.id);
      }
      if (deflected.size === before) return this.inputs(base, deflected);
    }
    throw new Error('Deflection cost planning did not converge');
  }
  finish(reactions: ActivatedReaction[]) {
    const effects: PendingEffect[] = [];
    for (const { impact } of this.impacts) {
      const responders = reactions.filter(
        (r) =>
          r.response.kind === 'deflect' &&
          r.matches.some((app) => app.projectileContact?.id === impact.projectile.id),
      );
      if (responders.length) this.deflect(impact, responders);
      else {
        effects.push(...impactEffects(impact, this.context, true, true));
        removeImpact(impact, this.context);
      }
    }
    return effects;
  }
  private deflect(impact: ProjectileImpact, responders: ActivatedReaction[]) {
    const { projectile, contact, curve } = impact;
    const { step, journal, changes } = this.context;
    const owner = responders[0]!.actor;
    const ownerId = owner.body.motion.actor.participant.actorId;
    if (projectile.deflection || responders.some((r) => r.actor !== owner))
      throw new Error('Invalid projectile replacement');
    const incomingVelocity = projectileVelocityAt(curve, contact.time);
    const observation = owner.mind.memory.observation?.enemy;
    const observedPosition =
      observation?.id === projectile.ownerId ? { ...observation.position } : undefined;
    const toward = observedPosition
      ? sub(observedPosition, contact.center)
      : mul(incomingVelocity, -1);
    const velocity = mul(
      unit(length(toward) > 1e-12 ? toward : mul(incomingVelocity, -1)),
      length(incomingVelocity),
    );
    const product =
      responders.reduce(
        (n, r) =>
          n * BigInt(r.response.kind === 'deflect' ? (r.response.powerBps ?? 10000) : 10000),
        10000n,
      ) /
      10000n ** BigInt(responders.length);
    const powerBps = Number(product > 30000n ? 30000n : product);
    const event = journal.emit({
      kind: 'projectile-deflect',
      step: step + 1,
      phase: 'resolution',
      actorId: ownerId,
      targetId: projectile.ownerId,
      entityId: projectile.id,
      parentEventId: impact.impact.id,
      causes: responders.map((r) => r.display.context.activationId),
      ruleId: 'projectile.deflect-once',
      point: contact.point,
    });
    const deflection: ProjectileDeflection = {
      eventId: event.id,
      originalOwnerId: projectile.ownerId,
      ownerId,
      step: step + 1,
      subtimeMicros: Math.round(contact.time * 1_000_000),
      point: { ...contact.point },
      position: { ...contact.center },
      incomingVelocity,
      velocity,
      basis: observedPosition ? 'observed-position' : 'reverse-incoming',
      ...(observedPosition ? { observedPosition } : {}),
      powerBps,
      activations: responders.map((r) => ({ abilityId: r.ability.id, context: r.display.context })),
    };
    event.projectileDeflection = deflection;
    const path = this.paths.find((p) => p.entityId === projectile.id)!;
    if (contact.time < 1 && path.segments.length >= 256)
      throw new SpatialBudgetError(
        'curve-segments',
        'deflection hold segment exceeds display path limit',
        { observed: path.segments.length + 1, limit: 256, cause: event.id },
      );
    if (contact.time < 1)
      path.segments.push({
        from: contact.time,
        to: 1,
        start: { ...contact.center },
        end: { ...contact.center },
      });
    const shape = projectile.ability.definition.attack;
    if (shape.kind !== 'projectile') throw new Error('Invalid deflected shape');
    if (step + 1 === projectile.launchStep + shape.lifetimeSteps) {
      changes.remove.push({ id: projectile.id, subtimeMicros: 1000000, reason: 'expired' });
      journal.emit({
        kind: 'projectile-remove',
        step: step + 1,
        phase: 'resolution',
        actorId: ownerId,
        sourceActorId: projectile.ownerId,
        sourceProjectileId: projectile.id,
        abilityId: projectile.ability.id,
        entityId: projectile.id,
        parentEventId: event.id,
        ruleId: 'projectile.expired',
        point: contact.center,
      });
    } else {
      this.alive.push({
        ...projectile,
        drainDisabled: true,
        ownerId,
        position: { ...contact.center },
        velocity,
        target: null,
        cause: event.id,
        deflection,
      });
      changes.update.push({
        id: projectile.id,
        ownerId,
        position: { ...contact.center },
        velocity,
        deflection,
      });
    }
  }
}
const deepest = (d: ProjectileDeflection) =>
  d.activations.reduce((a, b) => (a.context.depth >= b.context.depth ? a : b));
