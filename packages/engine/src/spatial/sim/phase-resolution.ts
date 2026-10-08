import { cancelEndedStops } from './time-stop-control.ts';
import { stopEffectHooks } from './time-stop-effects.ts';
import { executedPhaseInterval } from './phasing.ts';
import { commitBarrierDamage } from './barrier-damage.ts';
import { cancelEndedObjects } from './spatial-commands.ts';
import { recoverActorResources } from '../rules/resource-step.ts';
import { statusRecoveryAdjustment } from '../rules/status-resources.ts';
import { selfView } from '../ai/self-view.ts';
import { checkStageInterruption, finishStages, interruptDamagedStages } from '../rules/stages.ts';
import { commitReactiveEffects } from './reactions.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import { cancelEndedRelocations } from './relocation.ts';
import { settleDefeatedDependents } from './dependents.ts';
export function resolutionPhase(tx: StepTransaction) {
  commitBarrierDamage(tx);
  const { battle, budget, world, work } = tx.context;
  const { step, journal, effects } = tx;
  const actors = tx.previous.actors,
    next = tx.next.actors;
  commitReactiveEffects(
    next,
    effects,
    {
      battle,
      journal,
      step,
      activationStep: step + 1,
      phase: 'resolution',
      budget,
      world,
      ...(tx.next.dependents ? { dependents: tx.next.dependents } : {}),
      ...stopEffectHooks(tx, {
        battle,
        journal,
        step,
        activationStep: step + 1,
        phase: 'resolution',
        budget,
        world,
      }),
      aliveAtStart: new Set(actors.filter((a) => a.vitals.resources.hp > 0).map(actorId)),
    },
    work.reactions,
    tx.projectileContacts,
  );
  settleDefeatedDependents(tx, step + 1, 'resolution');
  interruptDamagedStages(next, step + 1, journal, 'resolution');
  for (const actor of next)
    checkStageInterruption(
      actor,
      selfView(actor, step + 1, battle.rules.ai, battle.statuses),
      step + 1,
      journal,
      'resolution',
    );
  finishStages(next, step + 1, journal);
  cancelEndedStops(tx);
  cancelEndedRelocations(tx);
  cancelEndedObjects(tx);
  executedPhaseInterval(tx);
  for (const actor of next) {
    if (tx.frozenAtStart.has(actorId(actor)) || !actor.vitals.staminaClock) continue;
    const start = actors.find((a) => actorId(a) === actorId(actor))!;
    recoverActorResources(
      actor,
      battle.rules.stepMs,
      step + 1,
      journal,
      statusRecoveryAdjustment(start.statuses, step),
    );
  }
}
