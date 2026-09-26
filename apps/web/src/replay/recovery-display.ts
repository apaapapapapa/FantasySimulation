import type { BattleEvent } from '@fantasy/domain/spatial';

/** Display only recorded credits; never infer recovery from HP movement or definitions. */
export function recoveryDisplay(events: readonly BattleEvent[]) {
  return events.flatMap((event) => {
    const absorption = event.damage?.absorption,
      drain = event.damage?.drain;
    return [
      ...(absorption && event.targetId
        ? [
            {
              id: event.id + ':absorption',
              actorId: event.targetId,
              label: `属性吸収（${absorption.element}）: ${absorption.converted}を変換 / 回復 ${absorption.healing}`,
            },
          ]
        : []),
      ...(drain && event.actorId
        ? [
            {
              id: event.id + ':drain',
              actorId: event.actorId,
              label: `ドレイン: ${event.actorId}が回復 ${drain.healing} / 実HP損失の配分 ${drain.basis.numerator}/${drain.basis.denominator}`,
            },
          ]
        : []),
    ];
  });
}
