import {
  assertNever,
  CharacterSchema,
  RulesetSchema,
  type Action,
  type BattleEvent,
  type BattleResult,
  type Character,
  type Ruleset,
} from '@fantasy/domain';

export const DEFAULT_RULESET: Readonly<Ruleset> = Object.freeze({
  version: '0.1.0',
  algorithm: 'basic-v1',
  maxRounds: 100,
});

function damageType(action: Action): 'physical' | 'magical' {
  switch (action.kind) {
    case 'weapon':
      return 'physical';
    case 'magic':
      return 'magical';
    default:
      return assertNever(action);
  }
}

function calculateDamage(actor: Character, target: Character, action: Action): number {
  let resistance = 0;
  for (const ability of target.abilities) {
    switch (ability.kind) {
      case 'resistance':
        if (ability.damageType === damageType(action)) {
          resistance = Math.max(resistance, ability.percent);
        }
        break;
      case 'regeneration':
        break;
      default:
        assertNever(ability);
    }
  }
  const base = Math.max(0, actor.stats.attack + action.power - target.stats.defense);
  return Math.floor((base * (100 - resistance)) / 100);
}

/** Pure, bounded starter rules. Identical inputs produce identical results. */
export function simulateBattle(
  leftInput: Character,
  rightInput: Character,
  rulesInput: Ruleset = DEFAULT_RULESET,
): BattleResult {
  const left = CharacterSchema.parse(leftInput);
  const right = CharacterSchema.parse(rightInput);
  const rules = RulesetSchema.parse(rulesInput);
  if (left.id === right.id) throw new Error('Choose two different character IDs.');

  // ID breaks speed ties consistently, independent of left/right selection.
  const first =
    left.stats.speed > right.stats.speed ||
    (left.stats.speed === right.stats.speed && left.id < right.id)
      ? left
      : right;
  const second = first.id === left.id ? right : left;
  const remainingHp: Record<string, number> = {
    [left.id]: left.stats.maxHp,
    [right.id]: right.stats.maxHp,
  };
  const events: BattleEvent[] = [];

  for (let round = 1; round <= rules.maxRounds; round++) {
    for (const [actor, target] of [
      [first, second],
      [second, first],
    ] as const) {
      const choices = actor.actions.map((action) => ({
        action,
        damage: calculateDamage(actor, target, action),
      }));
      // Stable sort keeps JSON action order when damage is tied.
      const selected = choices.sort((a, b) => b.damage - a.damage)[0];
      if (!selected) throw new Error('A character must have an action.');
      const targetHp = remainingHp[target.id] ?? target.stats.maxHp;
      const damage = Math.min(targetHp, selected.damage);
      remainingHp[target.id] = targetHp - damage;
      events.push({
        kind: 'attack',
        round,
        actorId: actor.id,
        targetId: target.id,
        actionName: selected.action.name,
        damageType: damageType(selected.action),
        damage,
        remainingHp: targetHp - damage,
      });
      if (remainingHp[target.id] === 0) {
        return {
          rulesVersion: rules.version,
          winnerId: actor.id,
          reason: 'knockout',
          rounds: round,
          remainingHp,
          events,
        };
      }
    }
    for (const actor of [first, second]) {
      let healing = 0;
      for (const ability of actor.abilities) {
        switch (ability.kind) {
          case 'regeneration':
            healing += ability.hpPerRound;
            break;
          case 'resistance':
            break;
          default:
            assertNever(ability);
        }
      }
      const hp = remainingHp[actor.id] ?? actor.stats.maxHp;
      const recoveredHp = Math.min(healing, actor.stats.maxHp - hp);
      if (recoveredHp > 0) {
        remainingHp[actor.id] = hp + recoveredHp;
        events.push({
          kind: 'regeneration',
          round,
          actorId: actor.id,
          recoveredHp,
          remainingHp: hp + recoveredHp,
        });
      }
    }
  }
  return {
    rulesVersion: rules.version,
    winnerId: null,
    reason: 'round-limit',
    rounds: rules.maxRounds,
    remainingHp,
    events,
  };
}
