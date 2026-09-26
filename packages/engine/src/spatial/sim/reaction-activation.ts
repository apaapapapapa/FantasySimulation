import type { ActorState, AbilityRevision } from '../state.ts';
import {
  compareIds,
  type Budget,
  type ReactionContext,
  type ReactionDisplay,
} from '@fantasy/domain/spatial/execution';
import type { PendingEffect, EffectContext } from './combat-effects.ts';
import { ResourceBudget } from '../rules/resources.ts';
import { abilityCategories, blockedBySilence } from '../rules/categories.ts';
import { postureAllows } from '../rules/posture.ts';
import { selfView } from '../ai/self-view.ts';
import { conditionMatches } from '../rules/conditions.ts';
import { actionClock } from '../rules/attacks.ts';
import { resourceReady } from '../rules/locomotion.ts';
import { SpatialBudgetError } from '../world/physics.ts';

const idOf = (actor: ActorState) => actor.body.motion.actor.participant.actorId;
export type ReactionWork = { attempts: number };
/** Work is external to provisional actor state; semantic uses are committed with the actors. */
export class ReactionBudget {
  private count = 0;
  private readonly budget: Budget;
  private matchCount: number;
  private readonly work: ReactionWork;
  constructor(budget: Budget, matchCount: number, work: ReactionWork) {
    this.budget = budget;
    this.matchCount = matchCount;
    this.work = work;
  }
  admit(depth: number, cause: string) {
    this.work.attempts++;
    const limits = [
      ['reaction-transaction', ++this.count, this.budget.maxReactionsPerTransaction ?? 64],
      ['reaction-match', ++this.matchCount, this.budget.maxReactionsPerMatch ?? 1024],
      ['reaction-depth', depth, this.budget.maxReactionDepth ?? 8],
    ] as const;
    for (const [resource, observed, limit] of limits)
      if (observed > limit)
        throw new SpatialBudgetError(
          resource,
          `observed=${observed}, limit=${limit}, cause=${cause}`,
          { observed, limit, cause },
        );
  }
}

export type ActivatedReaction = {
  actor: ActorState;
  ability: AbilityRevision;
  response: NonNullable<AbilityRevision['definition']['reaction']>['response'];
  display: ReactionDisplay;
  matches: PendingEffect[];
};
export type ReactionActivationState = {
  context: EffectContext;
  alive: ReadonlySet<string>;
  limit: ReactionBudget;
};

export function matchesReaction(
  ability: AbilityRevision,
  app: PendingEffect,
  actors: ActorState[],
) {
  if (!app.actorId || app.actorId === app.targetId) return false;
  const reaction = ability.definition.reaction!;
  if (
    reaction.response.kind === 'deflect' &&
    (!app.projectileContact?.direct || app.projectileContact.reflected)
  )
    return false;
  const source =
    app.sourceAbility ??
    actors
      .find((a) => idOf(a) === app.actorId)
      ?.body.motion.actor.abilities.find((a) => a.id === app.abilityId);
  if (
    reaction.categories &&
    (!source || !reaction.categories.some((c) => abilityCategories(source.definition).includes(c)))
  )
    return false;
  return (
    !reaction.elements ||
    reaction.elements.some((element) =>
      app.effect.kind === 'damage'
        ? app.effect.element === element
        : app.effect.kind === 'water' && element === 'water',
    )
  );
}

/** Pure eligibility shared by cost planning and activation. A deflection owns its
 * contact; competing parries retain only their other matches before reservation. */
export function reactionCandidates(
  actor: ActorState,
  actors: ActorState[],
  incoming: PendingEffect[],
  point: ReactionContext['point'],
  context: EffectContext,
) {
  const { battle, step, activationStep } = context;
  const view = selfView(actor, step, battle.rules.ai, battle.statuses);
  let eligible = actor.body.motion.actor.abilities
    .filter((a) => {
      const d = a.definition;
      return (
        d.reaction &&
        d.trigger === point &&
        !view.incapacitated &&
        postureAllows(actor.body.motion, d) &&
        !(view.silenced && blockedBySilence(d)) &&
        (actor.actions.cooldowns[a.id] ?? 0) <= activationStep &&
        (!d.costs.uses || (actor.actions.used[a.id] ?? 0) < d.costs.uses) &&
        conditionMatches(d.condition, view)
      );
    })
    .map((ability) => ({
      ability,
      matches: incoming.filter(
        (app) => app.targetId === idOf(actor) && matchesReaction(ability, app, actors),
      ),
      clock: actionClock(
        ability.definition,
        actor.body.motion.actor.character.stats.actionSpeedBps,
        activationStep,
      ),
    }))
    .filter((a) => a.clock && (point === 'before-defeat' || a.matches.length))
    .sort((a, b) => compareIds(a.ability.id, b.ability.id));

  if (point === 'before-hit') {
    const deflecting = new Set(
      eligible
        .filter((e) => e.ability.definition.reaction!.response.kind === 'deflect')
        .flatMap((e) => e.matches.map((app) => app.projectileContact!.id)),
    );
    eligible = eligible
      .map((e) =>
        e.ability.definition.reaction!.response.kind === 'parry'
          ? {
              ...e,
              matches: e.matches.filter(
                (app) => !app.projectileContact || !deflecting.has(app.projectileContact.id),
              ),
            }
          : e,
      )
      .filter((e) => e.matches.length);
  }
  return eligible;
}
export function reactionAffordable(
  actor: ActorState,
  eligible: ReturnType<typeof reactionCandidates>,
  context: EffectContext,
) {
  const view = selfView(actor, context.step, context.battle.rules.ai, context.battle.statuses);
  return new ResourceBudget(
    actor.vitals.resources,
    actor.actions.used,
    resourceReady(view),
  ).reserve(
    'reaction',
    eligible.map(({ ability }) => ({
      ...ability.definition.costs,
      uses: { id: ability.id, limit: ability.definition.costs.uses },
    })),
  ).ok;
}

/** Admission is shared by every phase. Owners reserve all eligible costs or none;
 * this function only mutates the caller's provisional transaction, never publishes it.
 */
export function activateReactions(
  actors: ActorState[],
  incoming: PendingEffect[],
  point: ReactionContext['point'],
  waveIndex: number,
  state: ReactionActivationState,
): ActivatedReaction[] {
  const { alive, limit } = state;
  const { battle, journal, step, activationStep, phase } = state.context;
  const activated: ActivatedReaction[] = [];
  for (const actor of [...actors].sort((a, b) => compareIds(idOf(a), idOf(b)))) {
    if (!alive.has(idOf(actor)) || (point === 'before-defeat' && actor.vitals.resources.hp > 0))
      continue;
    const eligible = reactionCandidates(actor, actors, incoming, point, state.context);
    if (!eligible.length) continue;
    const view = selfView(actor, step, battle.rules.ai, battle.statuses);
    const resources = new ResourceBudget(
      actor.vitals.resources,
      actor.actions.used,
      resourceReady(view),
    );
    const held = resources.reserve(
      'reaction',
      eligible.map(({ ability }) => ({
        ...ability.definition.costs,
        uses: { id: ability.id, limit: ability.definition.costs.uses },
      })),
    );
    if (!held.ok) {
      journal.emit({
        kind: 'fizzle',
        step: activationStep,
        phase,
        actorId: idOf(actor),
        ruleId: 'reaction.cost-group',
        reason: `all-or-none:${held.reason}`,
      });
      continue;
    }
    const plans = eligible.map((entry) => {
      const basis =
        point === 'before-defeat'
          ? incoming.filter((app) => app.targetId === idOf(actor))
          : entry.matches;
      const depth =
        1 + Math.max(0, ...basis.map((app) => app.reaction?.depth ?? app.ancestry?.depth ?? 0));
      const causes = [
        ...new Set(
          basis
            .flatMap((app) => [app.parentEventId, ...(app.causes ?? [])])
            .filter((id): id is string => !!id),
        ),
      ].sort(compareIds);
      limit.admit(depth, `${idOf(actor)}:${entry.ability.id}:${point}:${causes[0] ?? 'defeat'}`);
      return { ...entry, depth, causes };
    });
    const payment = resources.commit('reaction');
    const settled = resources.finish();
    actor.vitals.resources = settled.resources;
    actor.actions.used = settled.used;
    const cost = journal.emit({
      kind: 'cost',
      step: activationStep,
      phase,
      actorId: idOf(actor),
      ruleId: 'reaction.cost-group',
      before: payment.before,
      after: payment.after,
      reason: point,
    });
    for (const plan of plans) {
      const { ability, clock } = plan;
      const response = ability.definition.reaction!.response;
      const event = journal.emit({
        kind: 'reaction',
        step: activationStep,
        phase,
        actorId: idOf(actor),
        abilityId: ability.id,
        parentEventId: cost.id,
        causes: plan.causes,
        ruleId: 'reaction.activated',
        wave: waveIndex,
        reason: response.kind,
      });
      const context: ReactionContext = {
        activationId: event.id,
        point,
        wave: waveIndex,
        depth: plan.depth,
      };
      event.reaction = context;
      const counter = response.kind === 'counter';
      const display: ReactionDisplay = {
        context,
        abilityId: ability.id,
        targetId: counter ? plan.matches[0]!.actorId! : idOf(actor),
        activatedAt: activationStep,
        readyAt: activationStep,
        recoveryUntil: clock!.recoveryUntil,
        cooldownUntil: clock!.cooldownUntil,
        state: counter ? 'queued' : 'applied',
      };
      actor.actions.cooldowns[ability.id] = Math.max(display.recoveryUntil, display.cooldownUntil);
      actor.actions.reactions ??= [];
      actor.actions.reactions = actor.actions.reactions.filter((r) => r.abilityId !== ability.id);
      actor.actions.reactions.push(display);
      actor.actions.reactions.sort((a, b) => compareIds(a.abilityId, b.abilityId));
      const queued = actor.actions.reactions.filter((r) => r.state === 'queued').length;
      if (queued > 64)
        throw new SpatialBudgetError(
          'reaction-queue',
          `observed=${queued}, limit=64, cause=${event.id}`,
          { observed: queued, limit: 64, cause: event.id },
        );
      activated.push({ actor, ability, response, display, matches: plan.matches });
    }
  }
  return activated;
}
