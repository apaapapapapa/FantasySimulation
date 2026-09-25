import { actionClock, declarationCost, inObservedRange } from '../attacks.ts';
import { ResourceBudget } from '../resources.ts';
import { resourceReady } from '../locomotion.ts';
import { selfView } from '../self-view.ts';
import { blockedBySilence } from '../categories.ts';
import { conditionMatches } from '../perception.ts';
import { admitPair, rejectPair } from '../pair-admission.ts';
import { postureAllows } from '../posture.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
export function startPhase(tx: StepTransaction) {
  const { battle } = tx.context;
  const { step, journal, aiBoundary, previousMovement } = tx;
  const next = tx.next.actors;
  const views = new Map(
    next.map((actor) => [actorId(actor), selfView(actor, step, battle.rules.ai, battle.statuses)]),
  );
  const resourceBudgets = new Map(
    next.map((actor) => [
      actorId(actor),
      new ResourceBudget(actor.resources, actor.used, resourceReady(views.get(actorId(actor))!)),
    ]),
  );
  for (const actor of next) {
    const view = views.get(actorId(actor))!;
    if (aiBoundary && step >= actor.readyAt && actor.decision.abilityId && !view.incapacitated) {
      const ability = actor.motion.actor.abilities.find((a) => a.id === actor.decision.abilityId)!;
      const definition = ability.definition;
      const clock = actionClock(
        definition,
        actor.motion.actor.character.stats.actionSpeedBps,
        step,
      );
      if (clock) {
        const resources = resourceBudgets.get(actorId(actor))!;
        if (actor.decision.dodge) {
          const admission = admitPair(actor, ability, resources, step);
          const legal =
            inObservedRange(definition, view) &&
            conditionMatches(definition.condition, view) &&
            !(view.silenced && blockedBySilence(definition));
          if (!admission.ok || !legal) {
            rejectPair(actor, previousMovement.get(actorId(actor))!);
            journal.emit({
              kind: 'fizzle',
              step,
              phase: 'declaration',
              actorId: actorId(actor),
              abilityId: ability.id,
              ruleId: 'action.pair',
              reason: admission.ok ? 'pair-condition' : `pair-${admission.reason}`,
            });
            continue;
          }
        }
        const payment = resources.reserve('action', [
          {
            ...declarationCost(definition),
            uses: { id: ability.id, limit: definition.costs.uses },
          },
        ]);
        const silenced = !!view.silenced && blockedBySilence(definition);
        if (
          !postureAllows(actor.motion, definition) ||
          !inObservedRange(definition, view) ||
          !payment.ok ||
          silenced
        ) {
          if (payment.ok) resources.cancel('action');
          actor.readyAt =
            step +
            Math.max(
              1,
              Math.ceil(
                (definition.recoverySteps * 10000) /
                  actor.motion.actor.character.stats.actionSpeedBps,
              ),
            );
          journal.emit({
            kind: 'fizzle',
            step,
            phase: 'declaration',
            actorId: actorId(actor),
            abilityId: ability.id,
            ruleId: 'action.start',
            reason: !payment.ok
              ? `insufficient-${payment.reason}`
              : silenced
                ? 'silenced'
                : !postureAllows(actor.motion, definition)
                  ? 'posture'
                  : 'observed-range-or-facing',
          });
        } else {
          const paid = resources.commit('action');
          const start = journal.emit({
            kind: 'cast-start',
            step,
            phase: 'declaration',
            actorId: actorId(actor),
            abilityId: ability.id,
            ruleId: 'action.start',
          });
          journal.emit({
            kind: 'cost',
            step,
            phase: 'declaration',
            actorId: actorId(actor),
            abilityId: ability.id,
            parentEventId: start.id,
            ruleId: 'action.cost',
            before: { ...actor.resources },
            after: { ...paid.after },
          });
          actor.resources = paid.after;
          actor.used = resources.finish().used;
          actor.cooldowns[ability.id] = clock.cooldownUntil;
          actor.readyAt = clock.recoveryUntil;
          actor.action = {
            id: `a.${tx.next.serial++}`,
            ability,
            cause: start.id,
            startedAt: step,
            ...clock,
            released: false,
            ...(definition.stages
              ? { stages: { index: -1, next: 0, active: false, cause: start.id } }
              : {}),
          };
          if (definition.movementWhileCasting === 'stop' && definition.castSteps > 0)
            actor.intent = { ...actor.intent, canMove: false };
        }
      }
    }
  }

  tx.resourceBudgets = resourceBudgets;
}
