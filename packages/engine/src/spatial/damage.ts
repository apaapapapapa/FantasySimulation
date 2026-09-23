import type { DeepReadonly, Effect } from '@fantasy/domain/spatial';

export type DamageEffect = DeepReadonly<Extract<Effect, { kind: 'damage' }>>;
export type DamageSource = { attack: number; magicPower?: number };
export type DamageTarget = { defense: number; magicDefense?: number; resistance: number };
/** G-03 supplies status-adjusted stats/resistance and these aggregate multipliers. */
export type DamageModifiers = { dealtBps?: number; receivedBps?: number };

const bounded = (value: number, max: number) => {
  if (!Number.isSafeInteger(value)) throw new Error('Damage input must be a safe integer');
  return BigInt(Math.max(0, Math.min(max, value)));
};
export const damageDefense = (effect: DamageEffect) => effect.defense ?? 'physical';
export const hasDamageFormula = (effect: DamageEffect) =>
  effect.scaling !== undefined || effect.defense !== undefined;

/** Additive terms round separately; legacy attackScaleBps keeps its original meaning. */
export function damagePower(effect: DamageEffect, source: DamageSource): bigint {
  let power =
    BigInt(effect.amount) + (BigInt(source.attack) * BigInt(effect.attackScaleBps)) / 10000n;
  for (const term of effect.scaling ?? []) {
    const value = term.stat === 'attack' ? source.attack : (source.magicPower ?? source.attack);
    power += (BigInt(value) * BigInt(term.ratioBps)) / 10000n;
  }
  return power;
}

/** Pure per-component arithmetic; shared shield and HP clamping belong to resolveEffects. */
export function calculateDamage(
  effect: DamageEffect,
  source: DamageSource,
  target: DamageTarget,
  coverageBps = 10000,
  modifiers: DamageModifiers = {},
) {
  const basePower = damagePower(effect, source);
  const defense = damageDefense(effect);
  const defenseApplied =
    defense === 'none'
      ? 0
      : defense === 'magic'
        ? (target.magicDefense ?? target.defense)
        : target.defense;
  const remaining = basePower > BigInt(defenseApplied) ? basePower - BigInt(defenseApplied) : 0n;
  const afterDefense = (remaining * bounded(coverageBps, 10000)) / 10000n;
  const afterResistance = (afterDefense * (10000n - bounded(target.resistance, 10000))) / 10000n;
  const afterDealt = (afterResistance * bounded(modifiers.dealtBps ?? 10000, 30000)) / 10000n;
  const afterModifiers = (afterDealt * bounded(modifiers.receivedBps ?? 10000, 30000)) / 10000n;
  return { basePower, defenseApplied, afterDefense, afterResistance, afterModifiers };
}

/** Preserve legacy active-attack snapshots when magicPower was omitted. */
export function damageSource(stats: DamageSource): DamageSource {
  return {
    attack: stats.attack,
    ...(stats.magicPower !== undefined && { magicPower: stats.magicPower }),
  };
}
