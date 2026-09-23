import type {
  ActorDisplay,
  AttackGeometry,
  BattleEvent,
  StageContact,
  ObservedStage,
} from '@fantasy/domain/spatial';
import type { AbilityRevision, ActionState, ActorState, MeleeState } from './combat-state.ts';
import { conditionMatches, type DecisionView } from './perception.ts';
import { inObservedRange } from './attacks.ts';
import { blockedBySilence } from './categories.ts';
import type { ResourceBudget } from './resources.ts';
import type { Journal } from './journal.ts';
import { admitMotionCost, rejectPair } from './pair-admission.ts';
import { mul, unit } from './math.ts';
import { hasForcedMotion } from './forces.ts';

export type StageRuntime = {
  index: number;
  next: number;
  active: boolean;
  cause: string;
  interruptedAt?: number;
  geometry?: AttackGeometry;
  motion?: NonNullable<NonNullable<ActorDisplay['action']>['stage']>['motion'];
};
/** Attached volumes disappear with their owner window; detached projectiles use their snapshots. */
export function attachedStageAlive(attack: MeleeState, actors: readonly ActorState[], at: number) {
  if (!attack.stage) return true;
  const action = actors.find((a) => a.motion.actor.participant.actorId === attack.actorId)?.action;
  const stage = action?.ability.definition.stages?.[attack.stage.stageIndex];
  return (
    action?.id === attack.stage.actionId &&
    action.stages?.interruptedAt === undefined &&
    !!stage &&
    at < action.launchAt + stage.offsetSteps + stage.durationSteps
  );
}
export const stageContact = (action: ActionState, index: number): StageContact => ({
  actionId: action.id,
  stageId: action.ability.definition.stages![index]!.id,
  stageIndex: index,
  emitterId: 0,
  hitGroupId: action.ability.definition.stages![index]!.hit?.group ?? 'shared',
});
export function stageDisplay(
  action: ActionState,
  step: number,
): NonNullable<ActorDisplay['action']>['stage'] {
  const runtime = action.stages;
  if (!runtime) return undefined;
  const plan = action.ability.definition.stages!,
    index = Math.max(0, runtime.index),
    stage = plan[index]!;
  const startAt = action.launchAt + stage.offsetSteps,
    endAt = startAt + stage.durationSteps;
  return {
    contact: stageContact(action, index),
    startAt,
    endAt,
    state:
      runtime.interruptedAt !== undefined
        ? 'interrupted'
        : step < action.launchAt
          ? 'preparing'
          : runtime.active && step < endAt
            ? 'active'
            : runtime.next === plan.length && step >= endAt
              ? 'complete'
              : 'waiting',
    shape: stage.attack?.kind ?? 'hold',
    ...(runtime.geometry ? { geometry: runtime.geometry } : {}),
    ...(runtime.motion ? { motion: structuredClone(runtime.motion) } : {}),
  };
}
export function interruptStage(
  actor: ActorState,
  at: number,
  journal: Journal,
  phase: BattleEvent['phase'],
  reason: string,
  causes: string[] = [],
) {
  const action = actor.action,
    runtime = action?.stages;
  if (!action || !runtime || runtime.interruptedAt !== undefined) return;
  runtime.interruptedAt = at;
  runtime.active = false;
  journal.emit({
    kind: 'stage-interrupt',
    step: at,
    phase,
    actorId: actor.motion.actor.participant.actorId,
    abilityId: action.ability.id,
    parentEventId: runtime.cause,
    causes,
    stage: stageContact(action, Math.max(0, runtime.index)),
    ruleId: 'stage.interrupt',
    reason,
  });
}
/** A visible cue has no plan IDs, future windows, costs or definition references. */
export function visibleStageCue(actor: ActorState, step: number): ObservedStage | undefined {
  if (hasForcedMotion(actor, step)) return { shape: 'hold', state: 'active', motion: 'forced' };
  const display = actor.action && stageDisplay(actor.action, step);
  if (!display || display.state === 'preparing' || display.state === 'complete') return undefined;
  return {
    shape: display.state === 'active' ? display.shape : 'hold',
    state: display.state,
    ...(display.state === 'active' && display.motion?.applied
      ? { motion: display.motion.kind }
      : {}),
  };
}
/** Conditions inspect the owner's available view. Recovery/cooldown never move on cancellation. */
export function checkStageInterruption(
  actor: ActorState,
  view: DecisionView,
  step: number,
  journal: Journal,
  phase: BattleEvent['phase'],
) {
  const action = actor.action,
    runtime = action?.stages;
  if (!action || !runtime || runtime.interruptedAt !== undefined) return;
  const stage = action.ability.definition.stages![Math.max(0, runtime.index)]!;
  if (
    !runtime.active &&
    runtime.next === action.ability.definition.stages!.length &&
    step >= action.launchAt + stage.offsetSteps + stage.durationSteps
  )
    return;
  const current =
    step < action.launchAt ||
    (runtime.active && step < action.launchAt + stage.offsetSteps + stage.durationSteps);
  const reason =
    actor.resources.hp === 0
      ? 'defeated'
      : view.incapacitated
        ? 'incapacitated'
        : view.silenced && blockedBySilence(action.ability.definition)
          ? 'silenced'
          : current && stage.interruptWhen && conditionMatches(stage.interruptWhen, view)
            ? 'interrupt-condition'
            : null;
  if (reason) interruptStage(actor, step, journal, phase, reason);
}
/** Damage attribution, rather than net HP loss, also handles simultaneous healing. */
export function interruptDamagedStages(
  actors: readonly ActorState[],
  at: number,
  journal: Journal,
  phase: BattleEvent['phase'],
) {
  for (const actor of actors) {
    const action = actor.action,
      runtime = action?.stages;
    if (!action || !runtime || (!runtime.active && at > action.launchAt)) continue;
    const stage = action.ability.definition.stages![Math.max(0, runtime.index)]!;
    if (!stage.interruptOnDamage) continue;
    const causes = journal.events
      .filter(
        (e) =>
          e.kind === 'damage' &&
          e.targetId === actor.motion.actor.participant.actorId &&
          e.damage &&
          BigInt(e.damage.toHp.numerator) > 0n,
      )
      .map((e) => e.id);
    if (causes.length) interruptStage(actor, at, journal, phase, 'damage', causes);
  }
}
export function finishStages(actors: readonly ActorState[], at: number, journal: Journal) {
  for (const actor of actors) {
    const action = actor.action,
      runtime = action?.stages;
    if (!action || !runtime?.active) continue;
    const stage = action.ability.definition.stages![runtime.index]!;
    if (action.launchAt + stage.offsetSteps + stage.durationSteps !== at) continue;
    runtime.active = false;
    journal.emit({
      kind: 'stage-end',
      step: at,
      phase: 'resolution',
      actorId: actor.motion.actor.participant.actorId,
      abilityId: action.ability.id,
      parentEventId: runtime.cause,
      stage: stageContact(action, runtime.index),
      ruleId: 'stage.end',
    });
  }
}
/** The coordinator calls once per interval; at most one non-overlapping stage can start. */
export function releaseStage(
  actor: ActorState,
  view: DecisionView,
  step: number,
  budget: ResourceBudget,
  journal: Journal,
  movement: { dodge: boolean; previous: Pick<ActorState, 'intent' | 'decision'> },
) {
  const action = actor.action!,
    runtime = action.stages!,
    plan = action.ability.definition.stages!;
  const index = runtime.next,
    stage = plan[index];
  if (runtime.interruptedAt !== undefined || !stage || action.launchAt + stage.offsetSteps !== step)
    return null;
  runtime.index = index;
  delete runtime.geometry;
  const definition = action.ability.definition;
  const reason = view.incapacitated
    ? 'incapacitated'
    : view.silenced && blockedBySilence(definition)
      ? 'silenced'
      : stage.interruptWhen && conditionMatches(stage.interruptWhen, view)
        ? 'interrupt-condition'
        : !conditionMatches(definition.condition, view) ||
            (stage.startCondition && !conditionMatches(stage.startCondition, view))
          ? 'start-condition'
          : stage.attack && !inObservedRange({ ...definition, attack: stage.attack }, view)
            ? 'observed-range-or-facing'
            : null;
  if (reason) {
    interruptStage(actor, step, journal, 'launch', reason);
    return null;
  }
  if (
    stage.selfMotion?.kind === 'leap' &&
    (!view.canMove || !actor.motion.grounded || actor.intent.flight)
  ) {
    interruptStage(actor, step, journal, 'launch', 'leap-requires-supported-voluntary-motion');
    return null;
  }
  if (stage.selfMotion && movement.dodge && actor.intent.canMove) {
    rejectPair(actor, movement.previous);
    movement = { ...movement, dodge: false };
    journal.emit({
      kind: 'fizzle',
      step,
      phase: 'launch',
      actorId: actor.motion.actor.participant.actorId,
      ruleId: 'stage.motion-slot',
      reason: 'Existing stage owns this interval; new dodge is infeasible',
    });
  }
  if ((index > 0 && stage.cost) || stage.selfMotion) {
    const admission = admitMotionCost(
      actor,
      budget,
      step,
      'stage-admission',
      index > 0 && stage.cost ? [stage.cost] : [],
      movement.dodge,
      stage.selfMotion?.kind === 'leap',
    );
    if (!admission.ok) {
      if (movement.dodge || actor.intent.jump) {
        rejectPair(actor, movement.previous);
        actor.intent.jump = false;
      }
      interruptStage(actor, step, journal, 'launch', `insufficient-${admission.reason}`);
      return null;
    }
  }
  if (index > 0 && stage.cost) {
    const payment = budget.reserve('stage', [stage.cost]);
    if (!payment.ok) {
      interruptStage(actor, step, journal, 'launch', `insufficient-${payment.reason}`);
      return null;
    }
    const paid = budget.commit('stage');
    actor.resources = paid.after;
    journal.emit({
      kind: 'cost',
      step,
      phase: 'launch',
      actorId: actor.motion.actor.participant.actorId,
      abilityId: action.ability.id,
      parentEventId: action.cause,
      stage: stageContact(action, index),
      ruleId: 'stage.cost',
      before: paid.before,
      after: paid.after,
    });
  }
  const start = journal.emit({
    kind: 'stage-start',
    step,
    phase: 'launch',
    actorId: actor.motion.actor.participant.actorId,
    abilityId: action.ability.id,
    parentEventId: action.cause,
    stage: stageContact(action, index),
    ruleId: 'stage.start',
  });
  action.released = true;
  action.stages = { index, next: index + 1, active: true, cause: start.id };
  if (stage.selfMotion) {
    const direction = unit({ ...actor.motion.facing, y: 0 });
    if (direction.x === 0 && direction.z === 0) direction.x = 1;
    action.stages.motion = {
      ...stage.selfMotion,
      fromStep: step,
      applied: false,
      direction: mul(direction, stage.selfMotion.kind === 'retreat' ? -1 : 1),
    };
  }
  const ability: AbilityRevision | null = stage.attack
    ? {
        ...action.ability,
        definition: { ...definition, attack: stage.attack, effects: stage.effects },
      }
    : null;
  return {
    ability,
    contact: stageContact(action, index),
    hit: stage.hit,
    cause: start.id,
    id: `${action.id}.s.${index}`,
  };
}
