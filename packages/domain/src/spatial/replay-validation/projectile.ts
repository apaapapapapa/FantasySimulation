import type { ProjectileDisplay } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import { recordedStage } from './stage.ts';
import { requireReplay } from './common.ts';
export function validateProjectile(context: ReplayContext, p: ProjectileDisplay, step: number) {
  const owner = context.actors.find((a) => a.participant.actorId === p.ownerId);
  const ability = owner?.abilities.find((a) => a.id === p.abilityId);
  const attack = p.stage ? recordedStage(ability, p.stage).attack : ability?.definition.attack;
  requireReplay(!!p.stage === !!ability?.definition.stages, 'projectile stage display');
  requireReplay(
    p.id.startsWith('projectile.') &&
      attack?.kind === 'projectile' &&
      p.radiusMm === attack.radiusMm &&
      p.endStep === p.launchStep + attack.lifetimeSteps &&
      p.launchStep <= step &&
      p.endStep > step,
    'projectile reference/time',
  );
}
