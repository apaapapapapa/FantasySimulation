import { abilityEffects } from '../contracts.ts';
import type { BattleEvent } from '../records.ts';
import type { ReplayContext } from './context.ts';
import { requireReplay } from './common.ts';

/** Validate optional recovery records and causal credits without re-executing combat. */
export function validateRecovery(
  context: ReplayContext,
  event: BattleEvent,
  events: readonly BattleEvent[],
) {
  const detail = event.damage;
  if (detail?.absorption || detail?.drain) {
    requireReplay(
      event.kind === 'damage' &&
        !!event.targetId &&
        !!detail.calculation &&
        !!event.before &&
        !!event.after,
      'recovery damage record',
    );
    const converted = BigInt(detail.absorption?.converted ?? 0);
    const total = BigInt(detail.calculation!.afterModifiers);
    if (detail.absorption)
      requireReplay(
        converted > 0n &&
          converted <= total &&
          detail.absorption.element === detail.calculation!.element &&
          BigInt(detail.absorption.healing) <= converted * 3n,
        'absorption conversion bounds',
      );
    const shieldN = BigInt(detail.absorbed.numerator),
      shieldD = BigInt(detail.absorbed.denominator);
    const hpN = BigInt(detail.toHp.numerator),
      hpD = BigInt(detail.toHp.denominator);
    requireReplay(
      shieldN * hpD + hpN * shieldD === (total - converted) * shieldD * hpD,
      'recovery damage attribution',
    );
    if (detail.drain) {
      const source = context.actors.find((a) => a.participant.actorId === event.actorId);
      const ability = source?.abilities.find((a) => a.id === event.abilityId);
      requireReplay(
        !!source &&
          !event.sourceActorId &&
          !event.sourceProjectileId &&
          event.actorId !== event.targetId &&
          !!ability &&
          abilityEffects(ability.definition).some(
            (e) => e.kind === 'damage' && !!e.drainBps && e.element === detail.calculation!.element,
          ),
        'drain source definition',
      );
      const n = BigInt(detail.drain.basis.numerator),
        d = BigInt(detail.drain.basis.denominator);
      requireReplay(
        n * hpD <= hpN * d && BigInt(detail.drain.healing) * d <= n * 3n,
        'drain HP-loss bounds',
      );
      const credits = events.filter(
        (e) => e.ruleId === 'damage.drain' && e.parentEventId === event.id,
      );
      requireReplay(credits.length === (detail.drain.healing > 0 ? 1 : 0), 'drain credit count');
    }
  }
  if (event.ruleId === 'damage.drain') {
    const cause = events.find((e) => e.id === event.parentEventId);
    requireReplay(
      event.kind === 'heal' &&
        !!cause?.damage?.drain &&
        event.actorId === cause.actorId &&
        event.targetId === cause.actorId &&
        event.abilityId === cause.abilityId &&
        !event.sourceActorId &&
        !event.sourceProjectileId &&
        event.amount === cause.damage.drain.healing &&
        event.amount > 0 &&
        event.step === cause.step &&
        event.wave === cause.wave &&
        event.causes.length === 1 &&
        event.causes[0] === cause.id,
      'drain causal credit',
    );
  }
}
