import type { ActorState, AbilityRevision } from '../state.ts';
import {
  compareIds,
  type Budget,
  type BattleEvent,
  type ReactionContext,
  type ReactionDisplay,
} from '@fantasy/domain/spatial/execution';
import {
  commitEffects,
  commitTransactionStatuses,
  type PendingEffect,
  type EffectContext,
} from './combat-effects.ts';
import type { Journal } from '../rules/journal.ts';
import { ResourceBudget } from '../rules/resources.ts';
import { abilityCategories, blockedBySilence } from '../rules/categories.ts';
import { postureAllows } from '../rules/posture.ts';
import { selfView } from '../ai/self-view.ts';
import { conditionMatches } from '../rules/conditions.ts';
import { actionClock } from '../rules/attacks.ts';
import { resourceReady } from '../rules/locomotion.ts';
import { SpatialBudgetError } from '../world/physics.ts';
import { statusDamageSource } from '../rules/status-damage.ts';

type Point = ReactionContext['point'];
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
        );
  }
}
function matches(ability: AbilityRevision, app: PendingEffect, actors: ActorState[]) {
  if (!app.actorId || app.actorId === app.targetId) return false;
  const reaction = ability.definition.reaction!;
  const source = actors
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
export function reactionPayload(
  actor: ActorState,
  ability: AbilityRevision,
  reaction: ReactionDisplay,
  parent: string,
  step: number,
): PendingEffect[] {
  return ability.definition.effects.map((effect) => ({
    actorId: idOf(actor),
    targetId: reaction.targetId,
    abilityId: ability.id,
    parentEventId: parent,
    reaction: reaction.context,
    effect,
    ...statusDamageSource(actor, ability, step),
  }));
}
export function cancelDeadCounters(
  actors: ActorState[],
  journal: Journal,
  step: number,
  phase: BattleEvent['phase'],
) {
  for (const actor of actors)
    for (const reaction of actor.actions.reactions ?? [])
      if (actor.vitals.resources.hp === 0 && reaction.state === 'queued') {
        reaction.state = 'cancelled';
        journal.emit({
          kind: 'reaction',
          step,
          phase,
          actorId: idOf(actor),
          abilityId: reaction.abilityId,
          targetId: reaction.targetId,
          parentEventId: reaction.context.activationId,
          reaction: reaction.context,
          ruleId: 'reaction.cancelled',
          reason: 'owner-defeated; paid cost retained',
        });
      }
}
/** One atomic transaction, with old statuses frozen until all accepted waves are known.
 * The caller owns the actor/journal/PRNG clone; no wave is published independently.
 */
export function commitReactiveEffects(
  actors: ActorState[],
  effects: PendingEffect[],
  context: EffectContext,
  work: ReactionWork,
) {
  const { battle, journal, step, activationStep, phase, budget } = context;
  if (!actors.some((a) => a.body.motion.actor.abilities.some((b) => b.definition.reaction))) {
    commitEffects(actors, effects, context);
    return;
  }
  const alive =
    context.aliveAtStart ?? new Set(actors.filter((a) => a.vitals.resources.hp > 0).map(idOf));
  const limit = new ReactionBudget(
    budget,
    actors.reduce(
      (sum, a) =>
        sum +
        a.body.motion.actor.abilities
          .filter((b) => b.definition.reaction)
          .reduce((n, b) => n + (a.actions.used[b.id] ?? 0), 0),
      0,
    ),
    work,
  );
  const all: ReturnType<typeof commitEffects>['applications'] = [];
  const wave = (pending: PendingEffect[], index = 0) => {
    const result = commitEffects(actors, pending, context, true, index);
    all.push(...result.applications);
    return result;
  };
  const activate = (point: Point, incoming: PendingEffect[], waveIndex: number) => {
    const activated: {
      actor: ActorState;
      ability: AbilityRevision;
      display: ReactionDisplay;
      matches: PendingEffect[];
    }[] = [];
    for (const actor of [...actors].sort((a, b) => compareIds(idOf(a), idOf(b)))) {
      if (!alive.has(idOf(actor)) || (point === 'before-defeat' && actor.vitals.resources.hp > 0))
        continue;
      const view = selfView(actor, step, battle.rules.ai, battle.statuses);
      const eligible = actor.body.motion.actor.abilities
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
            (app) => app.targetId === idOf(actor) && matches(ability, app, actors),
          ),
          clock: actionClock(
            ability.definition,
            actor.body.motion.actor.character.stats.actionSpeedBps,
            activationStep,
          ),
        }))
        .filter((a) => a.clock && (point === 'before-defeat' || a.matches.length))
        .sort((a, b) => compareIds(a.ability.id, b.ability.id));
      if (!eligible.length) continue;
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
        const depth = 1 + Math.max(0, ...basis.map((app) => app.reaction?.depth ?? 0));
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
          reason: ability.definition.reaction!.response.kind,
        });
        const context: ReactionContext = {
          activationId: event.id,
          point,
          wave: waveIndex,
          depth: plan.depth,
        };
        event.reaction = context;
        const counter = ability.definition.reaction!.response.kind === 'counter';
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
        actor.actions.cooldowns[ability.id] = Math.max(
          display.recoveryUntil,
          display.cooldownUntil,
        );
        actor.actions.reactions ??= [];
        actor.actions.reactions = actor.actions.reactions.filter((r) => r.abilityId !== ability.id);
        actor.actions.reactions.push(display);
        actor.actions.reactions.sort((a, b) => compareIds(a.abilityId, b.abilityId));
        const queued = actor.actions.reactions.filter((r) => r.state === 'queued').length;
        if (queued > 64)
          throw new SpatialBudgetError(
            'reaction-queue',
            `observed=${queued}, limit=64, cause=${event.id}`,
          );
        activated.push({ actor, ability, display, matches: plan.matches });
      }
    }
    return activated;
  };
  const before = activate('before-hit', effects, 0);
  const cancelled = new Set<PendingEffect>();
  const damageCancelled = new Map<PendingEffect, string[]>();
  const extra: PendingEffect[] = [];
  for (const reaction of before) {
    const response = reaction.ability.definition.reaction!.response;
    if (response.kind === 'parry') {
      for (const matched of reaction.matches) {
        const contact = effects.filter(
          (app) =>
            app.actorId === matched.actorId &&
            app.targetId === matched.targetId &&
            app.abilityId === matched.abilityId &&
            app.parentEventId === matched.parentEventId,
        );
        for (const app of contact)
          if (response.scope === 'all') cancelled.add(app);
          else if (app.effect.kind === 'damage' && matches(reaction.ability, app, actors))
            damageCancelled.set(app, [
              ...(damageCancelled.get(app) ?? []),
              reaction.display.context.activationId,
            ]);
      }
    } else
      extra.push(
        ...reactionPayload(
          reaction.actor,
          reaction.ability,
          reaction.display,
          reaction.display.context.activationId,
          step,
        ),
      );
  }
  const primary = wave([
    ...effects
      .filter((app) => !cancelled.has(app))
      .map((app) => {
        const causes = damageCancelled.get(app);
        return causes
          ? { ...app, damageCancelled: true, causes: [...(app.causes ?? []), ...causes] }
          : app;
      }),
    ...extra,
  ]);
  const positive = primary.applications
    .filter(
      (app) =>
        app.effect.kind === 'damage' &&
        primary.resolved.some((r) =>
          r.damage.some((d) => d.applicationId === app.id && BigInt(d.toHp.numerator) > 0n),
        ),
    )
    .map((app) => ({ ...app, parentEventId: app.id }));
  const after = activate('after-damage', positive, 0);
  const afterEffects = after
    .filter((r) => r.ability.definition.reaction!.response.kind === 'effects')
    .flatMap((r) =>
      reactionPayload(r.actor, r.ability, r.display, r.display.context.activationId, step),
    );
  if (afterEffects.length) wave(afterEffects, 1);
  const defeated = activate(
    'before-defeat',
    all.map((app) => ({ ...app, parentEventId: app.id })),
    afterEffects.length ? 1 : 0,
  );
  const defeatEffects = defeated.flatMap((r) =>
    reactionPayload(r.actor, r.ability, r.display, r.display.context.activationId, step),
  );
  if (defeatEffects.length) wave(defeatEffects, afterEffects.length ? 2 : 1);
  commitTransactionStatuses(actors, all, context);
  cancelDeadCounters(actors, journal, activationStep, phase);
}
