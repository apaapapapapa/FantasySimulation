import type { ReplayCheckpoint, ReplayContext } from '@fantasy/domain/spatial';
import { motionSummary } from './motion-labels.ts';
import { stageCount } from './scene-model.ts';

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
          const definition = context.actors.find(
            (entry) => entry.participant.actorId === actor.id,
          )!.character;
          const limits = {
            hp: definition.stats.hp,
            mp: definition.stats.mp,
            shield: Math.max(definition.stats.shield, actor.resources.shield),
            stamina: definition.stamina?.max,
          };
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
                <ul aria-label={`${actor.id} 動作`}>
                  {motionSummary(
                    actor,
                    actor.action ? stageCount(context, definition, actor.action.abilityId) : null,
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
