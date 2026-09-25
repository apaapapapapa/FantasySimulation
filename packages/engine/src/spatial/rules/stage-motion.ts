import type { ActionState, ActorState } from '../state.ts';

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
  delete actor.body.intent.authored;
  const action = actor.actions.action,
    runtime = action?.stages,
    motion = runtime?.motion;
  if (!action || !runtime?.active || !motion || !ownsStageMotion(action, step)) return;
  runtime.motion = {
    ...motion,
    fromStep: step,
    applied: actor.body.intent.canMove && !actor.body.intent.forced,
  };
  if (!runtime.motion.applied) return;
  const stage = action.ability.definition.stages![runtime.index]!;
  actor.body.intent.authored = {
    direction: motion.direction,
    speedMmPerSecond: motion.speedMmPerSecond,
    accelerationMmPerSecond2: motion.accelerationMmPerSecond2,
    jump: motion.kind === 'leap' && step === action.launchAt + stage.offsetSteps,
  };
}
