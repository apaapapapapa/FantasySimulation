import { attackActiveSteps } from '../combat-derivations.ts';
import type { ActorDisplay } from '../stream.ts';
import type { ReplayActor } from './context.ts';
import { requireReplay } from './common.ts';
import { validateStage } from './stage.ts';
export function validateAction(actor: ActorDisplay, definition: ReplayActor, step: number) {
  if (actor.action) {
    const action = actor.action;
    const ability = definition.abilities.find((a) => a.id === action.abilityId);
    const activeSteps = ability ? attackActiveSteps(ability.definition.attack) : 1;
    const activeUntil = action.activeUntil ?? action.launchAt + activeSteps;
    validateStage(actor, ability, step, activeUntil);
    requireReplay(
      !!ability &&
        action.startedAt <= step &&
        action.startedAt <= action.launchAt &&
        action.launchAt < action.recoveryUntil &&
        step < action.recoveryUntil &&
        (step < action.launchAt
          ? action.phase === 'cast'
          : action.phase !== 'cast' && (action.phase !== 'active' || step < activeUntil)),
      'action reference/time',
    );
  }
}
