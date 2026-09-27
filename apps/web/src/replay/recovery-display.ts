import type { BattleEvent } from '@fantasy/domain/spatial';

/** Display only recorded credits; never infer recovery from HP movement or definitions. */
export function recoveryDisplay(events: readonly BattleEvent[]) {
  return events.flatMap((event) => {
    const absorption = event.damage?.absorption,
      drain = event.damage?.drain;
    return [
      ...(event.timeStop && event.targetId
        ? [
            {
              id: event.id + ':stop',
              actorId: event.targetId,
              label: `時間停止: ${{ queued: '予約', activated: '開始', fizzle: '不成立', capture: '接触を保留', release: '解除' }[event.timeStop.state]} / 使用 ${event.timeStop.uses}/4回 / 停止枠 ${event.timeStop.reservedSteps * 0.02}秒 / 実行 ${event.timeStop.executedSteps * 0.02}秒`,
            },
          ]
        : []),
      ...(event.evasion && event.actorId
        ? [
            {
              id: event.id + ':evasion',
              actorId: event.actorId,
              label: '絶対回避: 接触全体を無効化',
            },
          ]
        : []),
      ...(event.cognition?.kind === 'knowledge' && event.cognition.readings && event.actorId
        ? event.cognition.readings.map((reading) => ({
            id: event.id + ':' + reading.eventId,
            actorId: event.actorId!,
            label:
              reading.field === 'health'
                ? `読心: HP割合 ${reading.range.low / 100}〜${reading.range.high / 100}%（観測時点 ${reading.sampledAt}、期限 ${reading.expiresAt}）`
                : `読心: 宣言済み行動 ${reading.action?.abilityId ?? '待機'}（観測時点 ${reading.sampledAt}、期限 ${reading.expiresAt}）`,
          }))
        : []),
      ...(event.immortality && event.actorId
        ? [
            {
              id: event.id + ':immortality',
              actorId: event.actorId,
              label: `不死: HP 1で耐える / 累積使用 ${event.immortality.use}回`,
            },
          ]
        : []),
      ...(event.defeat && event.targetId
        ? [
            {
              id: event.id + ':defeat',
              actorId: event.targetId,
              label: `即死: ${event.defeat.applied ? '成立' : event.defeat.reason === 'immune' ? '耐性で無効' : '条件不成立'}`,
            },
          ]
        : []),
      ...(event.revival && event.actorId
        ? [
            {
              id: event.id + ':revival',
              actorId: event.actorId,
              label: `蘇生: HP ${event.before?.hp} → ${event.after?.hp} / 使用 ${event.revival.use}/4回`,
            },
          ]
        : []),
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
