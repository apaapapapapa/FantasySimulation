import { useEffect, useState } from 'react';
import type { ReplayCheckpoint } from '@fantasy/domain/spatial';
import { openReplay, type OpenedReplay, type ReplaySource } from './open-replay.ts';
import { seekStep } from './seek-step.ts';
import { errorText } from '../api-client.ts';

export function ReplayPanel({ source }: { source: ReplaySource }) {
  const [replay, setReplay] = useState<OpenedReplay | null>(null);
  const [state, setState] = useState<ReplayCheckpoint | null>(null);
  const [target, setTarget] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setReplay(null);
    setState(null);
    setTarget(0);
    setError('');
    setLoading(true);
    void openReplay(source, { signal: controller.signal })
      .then((opened) => {
        if (!controller.signal.aborted) setReplay(opened);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [source]);
  useEffect(() => {
    if (!replay) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void seekStep(replay, target, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setState(next.checkpoint());
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [replay, target]);
  const end = replay?.manifest.end;
  const last = replay?.manifest.lastVerifiedStep ?? 0;
  const events = state?.lastRecord && 'events' in state.lastRecord ? state.lastRecord.events : [];
  return (
    <section className="panel" aria-label="保存リプレイ">
      <h2>保存リプレイ</h2>
      {loading && (
        <p role="status" aria-label="読込状態">
          記録を読み込んでいます
        </p>
      )}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {replay && (
        <>
          <p>
            リプレイID <output aria-label="リプレイID">{replay.manifest.id}</output>
          </p>
          <p>
            保存結果:{' '}
            <output aria-label="リプレイ結果">
              {end?.kind === 'result' ? end.result.outcome.kind : end?.kind}
            </output>{' '}
            / 記録済み範囲 0–{last}
          </p>
          {end?.kind === 'result' && 'reason' in end.result.outcome && (
            <p>{end.result.outcome.reason}</p>
          )}
          {end?.kind !== 'result' && <p>{end?.reason}</p>}
          <label>
            表示step
            <input
              type="range"
              min="0"
              max={last}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
            />
          </label>
          <div className="actions">
            <button disabled={!target} onClick={() => setTarget((n) => n - 1)}>
              1step戻る
            </button>
            <button disabled={target >= last} onClick={() => setTarget((n) => n + 1)}>
              1step進む
            </button>
          </div>
          <p>
            表示中のstep: <output aria-label="現在のstep">{state?.step ?? '—'}</output>
          </p>
          <table aria-label="記録された状態">
            <thead>
              <tr>
                <th>参加者</th>
                <th>位置</th>
                <th>HP</th>
                <th>MP</th>
                <th>Shield</th>
                <th>Stamina</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {state?.state?.actors.map((actor) => (
                <tr key={actor.id}>
                  <th>{actor.id}</th>
                  <td>{JSON.stringify(actor.position)}</td>
                  <td>{actor.resources.hp}</td>
                  <td>{actor.resources.mp}</td>
                  <td>{actor.resources.shield}</td>
                  <td>{actor.resources.stamina ?? '記録なし'}</td>
                  <td>
                    {actor.statuses
                      .map((s) => `${s.revision.id} r${s.revision.revision}`)
                      .join(', ') || 'なし'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>この記録のイベント</h3>
          <ul aria-label="イベントログ">
            {events.map((event) => (
              <li key={event.id}>
                <details>
                  <summary>
                    {event.id} · {event.kind} ·{' '}
                    {event.cognition ? 'AIの観測・判断' : '確定イベント'}
                  </summary>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
          <details>
            <summary>保存結果のhash</summary>
            <pre aria-label="保存結果のhash">
              {JSON.stringify(end?.kind === 'result' ? end.result : end, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
