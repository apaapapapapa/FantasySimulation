import { matchesForceDisplay } from './effect.ts';
import { composeForce, DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND } from '../combat-derivations.ts';
import type { ActorDisplay } from '../stream.ts';
import type { ForceContribution } from '../records.ts';
import type { ReplayContext } from './context.ts';
import { recordedStage } from './stage.ts';
import { requireReplay } from './common.ts';
export function validateForce(context: ReplayContext, force: ForceContribution) {
  const ability = context.actors
    .find((a) => a.participant.actorId === (force.sourceActorId ?? force.actorId))
    ?.abilities.find((a) => a.id === force.abilityId);
  const effects = force.stage
    ? recordedStage(ability, force.stage).effects
    : ability?.definition.effects;
  requireReplay(!!effects?.some((e) => matchesForceDisplay(e, force)), 'force definition');
}

export function validateForces(context: ReplayContext, actor: ActorDisplay, step: number) {
  if (actor.force) {
    const force = actor.force;
    requireReplay(
      force.capMmPerSecond ===
        (context.rules.forcedSpeedCapMmPerSecond ?? DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND) &&
        force.fromStep === step - 1 &&
        force.contributors.length > 0 &&
        new Set(force.contributors.map((f) => f.id)).size === force.contributors.length,
      'force interval/contributors',
    );
    for (const contribution of force.contributors) {
      validateForce(context, contribution);
      requireReplay(
        contribution.startAt <= force.fromStep && force.fromStep < contribution.endAt,
        'force active window',
      );
    }
    const composed = composeForce(force.contributors, force.capMmPerSecond);
    requireReplay(
      force.active === composed.active &&
        force.capped === composed.capped &&
        (['x', 'y', 'z'] as const).every(
          (axis) => Math.abs(force.applied[axis] - composed.force[axis]) < 1e-9,
        ) &&
        (force.active
          ? !!force.gravityBefore &&
            !!force.gravityAfter &&
            !!force.incident &&
            !!force.projectedForce
          : !force.incident && !force.projectedForce && !force.projections.length),
      'force applied sum',
    );
    requireReplay(
      force.projections.every(
        (p, i) => i === 0 || p.fraction >= force.projections[i - 1]!.fraction,
      ),
      'force projection order',
    );
  }
}
