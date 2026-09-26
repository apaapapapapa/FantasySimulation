import { damageBarrierContact } from './barrier-damage.ts';
import { statusDamageSource } from '../rules/status-damage.ts';
import { inObservedRange } from '../rules/attacks.ts';
import { selfView } from '../ai/self-view.ts';
import { blockedBySilence } from '../rules/categories.ts';
import { conditionMatches } from '../rules/conditions.ts';
import { isDodgeDecision } from '../ai/policy.ts';
import { releaseStage } from '../rules/stages.ts';
import { applyStageMotion } from '../rules/stage-motion.ts';
import { releaseCounters } from './counter-release.ts';
import { postureAllows } from '../rules/posture.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import { releaseAttack } from './attack-release.ts';
export function releasePhase(tx: StepTransaction) {
  const { battle, world, work } = tx.context;
  const { step, journal, effects, resourceBudgets, forcePlans, aiBoundary, previousMovement } = tx;
  const next = tx.next.actors,
    nextLedger = tx.next.ledger;
  for (const actor of next) {
    const action = actor.actions.action;
    if (!action) continue;
    if (!action.stages && (action.released || action.launchAt !== step)) continue;
    const releaseView = selfView(actor, step, battle.rules.ai, battle.statuses);
    const staged = action.stages
      ? releaseStage(actor, releaseView, step, resourceBudgets.get(actorId(actor))!, journal, {
          dodge: aiBoundary && isDodgeDecision(actor.mind.decision),
          previous: previousMovement.get(actorId(actor))!,
        })
      : null;
    if (action.stages && !staged?.ability) continue;
    if (!staged) action.released = true;
    const ability = staged?.ability ?? action.ability;
    const definition = ability.definition;
    if (
      !postureAllows(actor.body.motion, definition) ||
      (!staged &&
        (!inObservedRange(definition, releaseView) ||
          releaseView.incapacitated ||
          !conditionMatches(definition.condition, releaseView) ||
          (releaseView.silenced && blockedBySilence(definition))))
    ) {
      journal.emit({
        kind: 'fizzle',
        step,
        phase: 'launch',
        actorId: actorId(actor),
        abilityId: ability.id,
        parentEventId: action.cause,
        ruleId: 'action.release',
        reason: 'Release condition/range no longer holds; cost is retained',
      });
      continue;
    }
    const launch = journal.emit({
      kind: 'launch',
      step,
      phase: 'launch',
      actorId: actorId(actor),
      abilityId: ability.id,
      parentEventId: staged?.cause ?? action.cause,
      ruleId: 'action.release',
      ...(staged ? { stage: staged.contact } : {}),
    });
    releaseAttack({ tx, actor, action, ability, staged, launch });
  }
  for (const actor of next) {
    const force = forcePlans.get(actorId(actor));
    if (force?.active) actor.body.intent.forced = { gravity: force.gravity!, force: force.force };
    applyStageMotion(actor, step);
  }
  effects.push(
    ...releaseCounters(
      next,
      battle,
      journal,
      world,
      step,
      nextLedger,
      () => {
        work.candidate();
      },
      (actor, ability, contact, cause) => {
        const shape = ability.definition.attack;
        if (shape.kind !== 'hitscan') throw new Error('Counter shape');
        damageBarrierContact(
          tx,
          { ownerId: actorId(actor), ability, cause, ...statusDamageSource(actor, ability, step) },
          contact,
          shape.radiusMm / 1000,
        );
      },
    ),
  );
}
