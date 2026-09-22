import {
  canonicalJson,
  deepFreeze,
  hashJson,
  sha256Text,
  SLOTS,
  TickBudgetSchema,
  type Slot,
  type TickAbility,
  type TickBudget,
  type TickEvent,
  type TickManifest,
  type TickOutcome,
  type TickReport,
  type TickStates,
} from '@fantasy/domain/tick-v1';
import { prepareTickBattle } from './manifest.ts';
import { characterRandomState, sampleBps } from './random.ts';

export const DEFAULT_TICK_BUDGET: Readonly<TickBudget> = Object.freeze({
  maxEvents: 50_000,
  maxTicks: 50_000,
  maxLogBytes: 8 * 1024 * 1024,
});

type Schedule = Record<Slot, { nextTick: number; cursor: number; randomState: number }>;
type Declaration = {
  actor: Slot;
  target: Slot;
  abilityRevisionId: string;
  ability: TickAbility;
  fizzleReason: 'insufficient-hp' | 'insufficient-mp' | null;
  nextActionTick: number;
};

function declare(
  manifest: TickManifest,
  state: TickStates,
  schedule: Schedule,
  tick: number,
): Declaration[] {
  return SLOTS.filter((actor) => schedule[actor].nextTick === tick).map((actor) => {
    const participant = manifest.participants[actor];
    const order = participant.strategy.definition.abilityRevisionIds;
    const abilityRevisionId = order[schedule[actor].cursor % order.length];
    const revision = participant.abilities.find(
      (ability) => ability.revisionId === abilityRevisionId,
    );
    if (!revision) throw new Error('Validated ability reference is missing');
    const ability = revision.definition;
    const delay = Math.max(
      1,
      Math.min(
        manifest.rules.definition.maxDelayTicks,
        Math.ceil(
          (ability.recoveryTicks * manifest.rules.definition.speedScale) /
            Math.max(1, participant.character.definition.stats.speed),
        ),
      ),
    );
    return {
      actor,
      target: actor === 'left' ? 'right' : 'left',
      abilityRevisionId: revision.revisionId,
      ability,
      fizzleReason:
        state[actor].hp < ability.cost.hp
          ? 'insufficient-hp'
          : state[actor].mp < ability.cost.mp
            ? 'insufficient-mp'
            : null,
      nextActionTick: tick + delay,
    };
  });
}

function missingInteractions(
  manifest: TickManifest,
  actions: Declaration[],
  tick: number,
): TickOutcome | undefined {
  const diagnostics: Extract<TickOutcome, { kind: 'unresolved' }>['diagnostics'] = [];
  for (const action of actions) {
    if (
      !action.fizzleReason &&
      action.ability.effect.kind === 'damage' &&
      action.ability.effect.aim === 'certain-hit' &&
      manifest.participants[action.target].character.definition.stats.avoidance === 'certain-evade'
    ) {
      diagnostics.push({
        code: 'missing-interaction',
        ruleId: 'accuracy.certain-hit-vs-certain-evade',
        tick,
        actor: action.actor,
        target: action.target,
        abilityRevisionId: action.abilityRevisionId,
      });
    }
  }
  return diagnostics.length ? { kind: 'unresolved', diagnostics } : undefined;
}

/** Calculate from one snapshot; the caller commits the entire batch only after reserving log space. */
function resolve(
  manifest: TickManifest,
  before: TickStates,
  schedule: Schedule,
  actions: Declaration[],
  tick: number,
) {
  const after: TickStates = { left: { ...before.left }, right: { ...before.right } };
  const next: Schedule = { left: { ...schedule.left }, right: { ...schedule.right } };
  const events: TickEvent[] = [];
  const healing = { left: 0, right: 0 };
  const incoming = { left: 0, right: 0 };
  for (const action of actions) {
    const { actor, ability, abilityRevisionId, fizzleReason, nextActionTick } = action;
    const paidCost = fizzleReason ? { hp: 0, mp: 0 } : { ...ability.cost };
    after[actor].hp -= paidCost.hp;
    after[actor].mp -= paidCost.mp;
    next[actor].cursor++;
    next[actor].nextTick = nextActionTick;
    events.push({
      kind: 'action',
      tick,
      ruleId: 'action.commit',
      actor,
      abilityRevisionId,
      effectKind: ability.effect.kind,
      paidCost,
      fizzleReason,
      nextActionTick,
    });
  }
  for (const action of actions) {
    if (action.fizzleReason) continue;
    const { actor, target, ability, abilityRevisionId } = action;
    const { effect } = ability;
    switch (effect.kind) {
      case 'damage': {
        const actorStats = manifest.participants[actor].character.definition.stats;
        const targetStats = manifest.participants[target].character.definition.stats;
        const random = sampleBps(next[actor].randomState);
        next[actor].randomState = random.state;
        const hit =
          effect.aim === 'certain-hit' ||
          (targetStats.avoidance !== 'certain-evade' && random.value < effect.accuracyBps);
        const baseDamage = hit
          ? Math.max(0, actorStats.attack + effect.power - targetStats.defense)
          : 0;
        const afterResistance = Math.floor(
          (baseDamage * (10_000 - targetStats.resistanceBps[effect.damageType])) / 10_000,
        );
        const absorbedByShield = Math.min(before[target].shield, afterResistance);
        const damageToHp = afterResistance - absorbedByShield;
        after[target].shield -= absorbedByShield;
        incoming[target] += damageToHp;
        events.push({
          kind: 'damage',
          tick,
          ruleId: 'damage.resolve',
          actor,
          target,
          abilityRevisionId,
          roll: random.value,
          hit,
          baseDamage,
          afterResistance,
          absorbedByShield,
          damageToHp,
        });
        break;
      }
      case 'heal':
        healing[actor] += effect.amount;
        events.push({
          kind: 'heal',
          tick,
          ruleId: 'heal.resolve',
          actor,
          abilityRevisionId,
          amount: effect.amount,
        });
        break;
      case 'wait':
        events.push({ kind: 'wait', tick, ruleId: 'action.wait', actor, abilityRevisionId });
        break;
      default: {
        const exhaustive: never = effect;
        throw new Error(`Unhandled effect: ${String(exhaustive)}`);
      }
    }
  }
  for (const actor of SLOTS) {
    after[actor].hp = Math.max(
      0,
      Math.min(
        manifest.participants[actor].character.definition.stats.maxHp,
        after[actor].hp + healing[actor] - incoming[actor],
      ),
    );
  }
  events.push({ kind: 'state', tick, ruleId: 'effects.commit', before, after });
  return { after, next, events };
}

function defeat(state: TickStates): TickOutcome | undefined {
  if (state.left.hp === 0 && state.right.hp === 0)
    return { kind: 'draw', reason: 'simultaneous-defeat' };
  if (state.left.hp === 0) return { kind: 'win', winner: 'right', reason: 'defeat' };
  if (state.right.hp === 0) return { kind: 'win', winner: 'left', reason: 'defeat' };
  return undefined;
}

export async function simulateTickBattle(
  input: unknown,
  budgetInput: unknown = DEFAULT_TICK_BUDGET,
): Promise<Readonly<TickReport>> {
  const budget = TickBudgetSchema.parse(budgetInput);
  const { manifest, simulationHash } = await prepareTickBattle(input);
  const randomStates = await Promise.all(
    SLOTS.map((actor) =>
      characterRandomState(
        manifest.random.seed,
        manifest.participants[actor].character.contentHash,
      ),
    ),
  );
  let schedule: Schedule = {
    left: { nextTick: 0, cursor: 0, randomState: randomStates[0]! },
    right: { nextTick: 0, cursor: 0, randomState: randomStates[1]! },
  };
  let state: TickStates = {
    left: { ...manifest.scenario.definition.initialState.left },
    right: { ...manifest.scenario.definition.initialState.right },
  };
  const events: TickEvent[] = [];
  const encodedEvents: string[] = [];
  let logBytes = 2; // The canonical JSON array's brackets.
  let processedTicks = 0;
  let tick = 0;

  function append(batch: TickEvent[], pendingTick: number): TickOutcome | undefined {
    const eventCount = events.length + batch.length;
    if (eventCount > budget.maxEvents)
      return {
        kind: 'truncated',
        reason: 'event-budget',
        pendingTick,
        limit: budget.maxEvents,
        required: eventCount,
      };
    const encoded = batch.map((event) => canonicalJson(event));
    const bytes =
      encoded.reduce((sum, event) => sum + new TextEncoder().encode(event).byteLength, 0) +
      batch.length -
      (events.length === 0 ? 1 : 0);
    if (logBytes + bytes > budget.maxLogBytes)
      return {
        kind: 'truncated',
        reason: 'log-byte-budget',
        pendingTick,
        limit: budget.maxLogBytes,
        required: logBytes + bytes,
      };
    events.push(...batch);
    encodedEvents.push(...encoded);
    logBytes += bytes;
    return undefined;
  }

  let outcome = append([{ kind: 'start', tick: 0, ruleId: 'battle.start', state }], 0);
  while (!outcome) {
    const pendingTick = Math.min(schedule.left.nextTick, schedule.right.nextTick);
    if (pendingTick > manifest.scenario.definition.maxTick) {
      tick = manifest.scenario.definition.maxTick;
      outcome = { kind: 'draw', reason: 'time-limit' };
      break;
    }
    if (processedTicks >= budget.maxTicks) {
      outcome = {
        kind: 'truncated',
        reason: 'tick-budget',
        pendingTick,
        limit: budget.maxTicks,
        required: processedTicks + 1,
      };
      break;
    }
    const actions = declare(manifest, state, schedule, pendingTick);
    outcome = missingInteractions(manifest, actions, pendingTick);
    if (outcome) break;
    const resolved = resolve(manifest, state, schedule, actions, pendingTick);
    outcome = append(resolved.events, pendingTick);
    if (outcome) break;
    tick = pendingTick;
    processedTicks++;
    state = resolved.after;
    schedule = resolved.next;
    outcome = defeat(state);
    if (!outcome && tick === manifest.scenario.definition.maxTick)
      outcome = { kind: 'draw', reason: 'time-limit' };
  }
  const eventsHash = await sha256Text(`[${encodedEvents.join(',')}]`);
  const resultHash = await hashJson({
    simulationHash,
    eventSchemaVersion: manifest.eventSchemaVersion,
    eventsHash,
    outcome,
    tick,
    finalState: state,
  });
  return deepFreeze({
    schemaVersion: 1,
    simulationHash,
    eventsHash,
    resultHash,
    outcome,
    tick,
    processedTicks,
    finalState: state,
    events,
    budget,
  });
}
