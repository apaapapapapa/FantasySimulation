import type { DeepReadonly } from './canonical.ts';
import type { Definition, Effect } from './contracts.ts';

type Attack = DeepReadonly<Definition<'ability'>['attack']>;
type ReadonlyEffect = DeepReadonly<Effect>;
export type AttackKind = Attack['kind'];
export type AttackVariant<K extends AttackKind = AttackKind> = {
  [P in K]: Extract<Attack, { kind: P }>;
}[K];
export type AttackHandlers<Context, Result> = {
  [K in AttackKind]: (attack: AttackVariant<K>, context: Context) => Result;
};
export function matchAttack<K extends AttackKind, Context, Result>(
  attack: AttackVariant<K>,
  handlers: AttackHandlers<Context, Result>,
  context: Context,
): Result {
  return handlers[attack.kind](attack, context);
}

export type EffectKind = Effect['kind'];
export type EffectVariant<K extends EffectKind = EffectKind> = {
  [P in K]: Extract<ReadonlyEffect, { kind: P }>;
}[K];
export type EffectHandlers<Context, Result> = {
  [K in EffectKind]: (effect: EffectVariant<K>, context: Context) => Result;
};
export function matchEffect<K extends EffectKind, Context, Result>(
  effect: EffectVariant<K>,
  handlers: EffectHandlers<Context, Result>,
  context: Context,
): Result {
  return handlers[effect.kind](effect, context);
}
