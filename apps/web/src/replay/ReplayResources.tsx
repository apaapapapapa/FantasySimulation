import type { ReplayCheckpoint, ReplayContext } from '@fantasy/domain/spatial';
import { motionSummary } from './motion-labels.ts';
import { stageCount } from './scene-model.ts';
import { sealDisplay } from './seal-display.ts';
import { recoveryDisplay } from './recovery-display.ts';
const effectNames = {
  damage: 'ダメージ',
  heal: '回復',
  shield: 'シールド',
  defeat: '即死',
  force: '強制移動',
  reveal: '情報開示',
  water: '水',
  dispel: '解除',
  'apply-status': '状態付与',
  'sensory-cue': '視覚幻惑',
};

export function ReplayResources({
  context,
  checkpoint,
}: {
  context: ReplayContext;
  checkpoint: ReplayCheckpoint;
}) {
  return (
    <table aria-label="記録された状態">
      <thead>
        <tr>
          {['参加者', '位置', 'HP', 'MP', 'Shield', 'Stamina', '状態・動作'].map((name) => (
            <th key={name}>{name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {checkpoint.state?.actors.map((actor) => {
          const loadout = context.actors.find((entry) => entry.participant.actorId === actor.id)!;
          const definition = loadout.character;
          const limits = {
            hp: definition.stats.hp,
            mp: definition.stats.mp,
            shield: Math.max(definition.stats.shield, actor.resources.shield),
            stamina: definition.stamina?.max,
          };
          const seals = sealDisplay(context, actor, checkpoint.step);
          return (
            <tr key={actor.id}>
              <th>
                {definition.name} ({actor.id})
                {definition.appearance && (
                  <small>
                    {' '}
                    {definition.appearance.silhouette} / {definition.appearance.surface}
                  </small>
                )}
                {recoveryDisplay(
                  checkpoint.lastRecord && 'events' in checkpoint.lastRecord
                    ? checkpoint.lastRecord.events
                    : [],
                )
                  .filter((item) => item.actorId === actor.id)
                  .map((item) => (
                    <p key={item.id}>{item.label}</p>
                  ))}
              </th>
              <td>{JSON.stringify(actor.position)}</td>
              {(['hp', 'mp', 'shield', 'stamina'] as const).map((resource) => {
                const value = actor.resources[resource],
                  max = limits[resource];
                return (
                  <td key={resource}>
                    {value === undefined ? (
                      '記録なし'
                    ) : (
                      <>
                        <meter
                          aria-label={`${actor.id} ${resource}`}
                          min={0}
                          max={Math.max(1, max ?? 0)}
                          value={value}
                        />{' '}
                        {value}
                        {resource !== 'shield' && max !== undefined && <> / {max}</>}
                      </>
                    )}
                  </td>
                );
              })}
              <td>
                {actor.clock && (
                  <p>
                    {actor.clock.frozen ? '時間停止中' : '時間停止解除済み'} / 本人の経過{' '}
                    {(actor.clock.subjectStep * 0.02).toFixed(2)}秒 / 累計停止{' '}
                    {(actor.clock.pausedSteps * 0.02).toFixed(2)}秒
                  </p>
                )}
                {!!checkpoint.deferred?.filter((receipt) => receipt.targetId === actor.id)
                  .length && (
                  <details>
                    <summary>
                      保留中の効果:{' '}
                      {
                        checkpoint.deferred.filter((receipt) => receipt.targetId === actor.id)
                          .length
                      }
                      件（解除時に反映）
                    </summary>
                    <ul>
                      {checkpoint.deferred
                        .filter((receipt) => receipt.targetId === actor.id)
                        .map((receipt) => (
                          <li key={receipt.id}>
                            {context.manifest.revisions.find(
                              (revision) =>
                                revision.kind === 'ability' && revision.id === receipt.abilityId,
                            )?.definition.name ?? receipt.abilityId}
                            {' / '}
                            {effectNames[receipt.effect.kind]}
                            {' / 接触時刻 '}
                            {(receipt.capturedAt * 0.02).toFixed(2)}秒
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
                {actor.revivals !== undefined && <p>蘇生: 使用 {actor.revivals}/4回</p>}
                {actor.immortalityUsed !== undefined && (
                  <p>不死: 累積使用 {actor.immortalityUsed}回</p>
                )}
                <ul aria-label={`${actor.id} 動作`}>
                  {motionSummary(
                    actor,
                    actor.action ? stageCount(loadout, actor.action.abilityId) : null,
                  ).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {actor.statuses.length ? (
                  <ul>
                    {actor.statuses.map((status, i) => {
                      const saved = context.manifest.revisions.find(
                        (r) =>
                          r.kind === 'status' &&
                          r.id === status.revision.id &&
                          r.revision === status.revision.revision,
                      );
                      return (
                        <li key={`${status.revision.id}:${i}`}>
                          {saved?.definition.name ?? status.revision.id} ×{status.stacks} / step{' '}
                          {status.startStep}–{status.endStep}
                          {seals[i]?.sealing && ' / 封印中'}
                          {seals[i]?.suppressed && ' / 封印により効果停止'}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  'なし'
                )}
                <details>
                  <summary>姿勢・技・移動・反応の記録</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        posture: actor.posture ?? '記録なし',
                        action: actor.action,
                        locomotion: actor.locomotion ?? '記録なし',
                        force: actor.force ?? '記録なし',
                        reactions: actor.reactions ?? '記録なし',
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
