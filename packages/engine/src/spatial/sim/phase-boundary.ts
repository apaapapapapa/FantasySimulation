import { commitEffects } from '../combat-effects.ts';
import { ResourceBudget } from '../resources.ts';
import { applyStatusResourcePulses } from '../status-resources.ts';
import { selfView } from '../self-view.ts';
import { conditionMatches } from '../perception.ts';
import { statusBoundary } from '../status.ts';
import { checkStageInterruption, interruptDamagedStages } from '../stages.ts';
import { commitReactiveEffects } from '../reactions.ts';
import { advancePosture } from '../posture.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import { effectsOf } from './step-effects.ts';
export function boundaryPhase(tx: StepTransaction) {
  const { battle, budget, world, work } = tx.context;
  const { step, journal } = tx;
  const actors = tx.previous.actors,
    next = tx.next.actors;
  for (const actor of next)
    actor.body.motion = advancePosture(
      actor.body.motion,
      undefined,
      step,
      world,
      actors.map((a) => a.body.motion),
    );
  if (step === 0) {
    const effects = tx.effects;
    for (const actor of next) {
      const startupView = selfView(actor, step, battle.rules.ai, battle.statuses);
      const startup = actor.body.motion.actor.abilities.filter(
        (a) =>
          a.definition.trigger === 'battle-start' &&
          conditionMatches(a.definition.condition, startupView),
      );
      const budget = new ResourceBudget(actor.vitals.resources, actor.actions.used);
      const reserved = budget.reserve(
        'startup',
        startup.map((a) => ({
          ...a.definition.costs,
          uses: { id: a.id, limit: a.definition.costs.uses },
        })),
      );
      if (!reserved.ok) {
        for (const ability of startup)
          journal.emit({
            kind: 'fizzle',
            step,
            phase: 'boundary',
            actorId: actorId(actor),
            abilityId: ability.id,
            ruleId: 'startup.cost-group',
            reason: 'Combined startup costs exceed resources; none are paid',
          });
        continue;
      }
      const old = { ...actor.vitals.resources };
      budget.commit('startup');
      const payment = budget.finish();
      actor.vitals.resources = payment.resources;
      actor.actions.used = payment.used;
      const cost = startup.length
        ? journal.emit({
            kind: 'cost',
            step,
            phase: 'boundary',
            actorId: actorId(actor),
            ruleId: 'startup.cost-group',
            before: old,
            after: { ...actor.vitals.resources },
            reason: 'Simultaneous startup cost group',
          })
        : null;
      for (const ability of startup) {
        const launch = journal.emit({
          kind: 'launch',
          step,
          phase: 'boundary',
          actorId: actorId(actor),
          abilityId: ability.id,
          parentEventId: cost!.id,
          ruleId: 'startup.launch',
        });
        effects.push(...effectsOf(actor, ability, actorId(actor), launch.id, step));
      }
    }
    commitEffects(next, effects, {
      battle,
      journal,
      step,
      activationStep: step,
      phase: 'boundary',
      budget,
      world,
    });
    tx.effects.length = 0;
  }
  const periodic = tx.effects;
  for (const actor of next) {
    const boundary = statusBoundary(actor.statuses, step);
    actor.statuses = boundary.statuses;
    for (const removed of boundary.removed)
      journal.emit({
        kind: 'status-remove',
        step,
        phase: 'boundary',
        actorId: actorId(actor),
        ruleId: 'status.expired',
        causes: [...removed.causes],
        reason: removed.revision.id,
      });
    applyStatusResourcePulses(actor, boundary.pulses, step, journal);
    for (const pulse of boundary.pulses) {
      if (pulse.effect.kind === 'resource') continue;
      periodic.push({
        actorId: null,
        targetId: actorId(actor),
        effect:
          pulse.effect.kind === 'heal'
            ? { kind: 'heal', amount: pulse.effect.amount }
            : {
                kind: 'damage',
                amount: pulse.effect.amount,
                attackScaleBps: 0,
                element: pulse.effect.element,
              },
        attack: 0,
        parentEventId: null,
        abilityId: null,
        causes: pulse.causes,
      });
    }
  }
  if (
    periodic.length ||
    next.some(
      (a) =>
        a.vitals.resources.hp === 0 &&
        a.body.motion.actor.abilities.some((b) => b.definition.reaction),
    )
  )
    commitReactiveEffects(
      next,
      periodic,
      {
        battle,
        journal,
        step,
        activationStep: step,
        phase: 'boundary',
        budget,
        world,
        aliveAtStart: new Set(actors.filter((a) => a.vitals.resources.hp > 0).map(actorId)),
      },
      work.reactions,
    );
  interruptDamagedStages(next, step, journal, 'boundary');
  for (const actor of next)
    checkStageInterruption(
      actor,
      selfView(actor, step, battle.rules.ai, battle.statuses),
      step,
      journal,
      'boundary',
    );
}
