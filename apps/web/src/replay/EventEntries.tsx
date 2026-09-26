import type { BattleEvent } from '@fantasy/domain/spatial';
import { recoveryDisplay } from './recovery-display.ts';

export function EventEntries({
  events,
  step,
  onSeek,
}: {
  events: readonly BattleEvent[];
  step: number;
  onSeek(step: number): void;
}) {
  return (
    <>
      {events.map((event) => (
        <li key={event.id} aria-current={event.step === step ? 'step' : undefined}>
          <button onClick={() => onSeek(event.step)}>
            step {event.step}へ: {event.id} {event.kind}
          </button>
          <details>
            <summary>
              {event.cognition ? 'AIの観測・判断（主観）' : '判定（全知）'} ·{' '}
              {event.actorId ?? '戦場'} · {event.ruleId}
            </summary>
            <p>
              親イベント: {event.parentEventId ?? 'なし'} / 原因:{' '}
              {event.causes.join(', ') || 'なし'}
            </p>
            {event.before && event.after && (
              <p>
                HP {event.before.hp} → {event.after.hp} / MP {event.before.mp} → {event.after.mp} /
                Shield {event.before.shield} → {event.after.shield}
              </p>
            )}
            {event.teleport && (
              <p>
                テレポート: ({event.teleport.from.x}, {event.teleport.from.y},{' '}
                {event.teleport.from.z}) → ({event.teleport.to.x}, {event.teleport.to.y},{' '}
                {event.teleport.to.z}) m。境界で移動し、経路は補間しません。
              </p>
            )}
            {event.damage && (
              <p>
                威力 {event.damage.calculation?.basePower ?? '記録なし'} → 防御後{' '}
                {event.damage.afterDefense} → 耐性後 {event.damage.afterResistance} → Shield吸収{' '}
                {event.damage.absorbed.numerator}/{event.damage.absorbed.denominator} → HP損失{' '}
                {event.damage.toHp.numerator}/{event.damage.toHp.denominator}
              </p>
            )}
            {recoveryDisplay([event]).map((item) => (
              <p key={item.id}>{item.label}</p>
            ))}
            <pre>{JSON.stringify(event.cognition ?? event, null, 2)}</pre>
          </details>
        </li>
      ))}
    </>
  );
}
