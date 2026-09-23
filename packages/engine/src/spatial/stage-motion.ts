import type { ActionState, ActorState } from './combat-state.ts';

/** Only current owner state; never ask for an opponent's authored plan. */
export function ownsStageMotion(action: ActionState | null, step: number): boolean {
  return (
    !!action?.stages &&
    action.stages.interruptedAt === undefined &&
    !!action.ability.definition.stages?.some(
      (stage) =>
        !!stage.selfMotion &&
        action.launchAt + stage.offsetSteps <= step &&
        step < action.launchAt + stage.offsetSteps + stage.durationSteps,
    )
  );
}
export function applyStageMotion(actor: ActorState, step: number) {
  delete actor.intent.authored;
  const action = actor.action,
    runtime = action?.stages,
    motion = runtime?.motion;
  if (!action || !runtime?.active || !motion || !ownsStageMotion(action, step)) return;
  runtime.motion = {
    ...motion,
    fromStep: step,
    applied: actor.intent.canMove && !actor.intent.forced,
  };
  if (!runtime.motion.applied) return;
  const stage = action.ability.definition.stages![runtime.index]!;
  actor.intent.authored = {
    direction: motion.direction,
    speedMmPerSecond: motion.speedMmPerSecond,
    accelerationMmPerSecond2: motion.accelerationMmPerSecond2,
    jump: motion.kind === 'leap' && step === action.launchAt + stage.offsetSteps,
  };
}
