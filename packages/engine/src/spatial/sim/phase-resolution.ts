import { recoverActorResources } from '../rules/resource-step.ts';
import { statusRecoveryAdjustment } from '../rules/status-resources.ts';
import { selfView } from '../ai/self-view.ts';
import { checkStageInterruption, finishStages, interruptDamagedStages } from '../rules/stages.ts';
import { commitReactiveEffects } from './reactions.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import { cancelEndedRelocations } from './relocation.ts';
export function resolutionPhase(tx: StepTransaction) {
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
      aliveAtStart: new Set(actors.filter((a) => a.vitals.resources.hp > 0).map(actorId)),
    },
    work.reactions,
  );
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
  cancelEndedRelocations(tx);
  for (const actor of next) {
    if (!actor.vitals.staminaClock) continue;
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
