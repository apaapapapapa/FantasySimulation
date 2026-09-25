import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openReplay, type OpenedReplay, type ReplaySource } from './open-replay.ts';
import { ReplayPlayer, type ReplayFrame } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { replayErrorText as errorText } from './load-message.ts';
import { SceneBoundary } from './SceneBoundary.tsx';
import { playbackStep } from './playback-clock.ts';
import type { CameraMode } from './Scene.tsx';
import { ReplayEvents, CurrentEvents } from './ReplayEvents.tsx';

const Scene = lazy(() => import('./Scene.tsx'));

export function ReplayPanel({ source }: { source: ReplaySource }) {
  const [replay, setReplay] = useState<OpenedReplay | null>(null);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const state = frame?.checkpoint;
  const [target, setTarget] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');
  const [overlays, setOverlays] = useState(false);
  const player = useMemo(
    () => (replay?.manifest.end.kind === 'result' ? new ReplayPlayer(replay) : null),
    [replay],
  );
  const model = useMemo(
    () => (replay && state ? buildSceneModel(replay.context, state) : null),
    [replay, state],
  );
  const panel = useRef<HTMLElement | null>(null);
  const cursor = useRef({ target, loading });
  const failed = useCallback((error: unknown, signal: AbortSignal) => {
    if (signal.aborted) return;
    setError(errorText(error));
    setLoading(false);
    setPlaying(false);
  }, []);
  useEffect(() => {
    if (replay) {
      panel.current?.focus({ preventScroll: true });
      panel.current?.scrollIntoView({ block: 'start' });
    }
  }, [replay]);
  useEffect(() => {
    cursor.current = { target, loading };
  }, [target, loading]);
  function seek(step: number) {
    setPlaying(false);
    setTarget(step);
  }
  useEffect(() => {
    const controller = new AbortController();
    setReplay(null);
    setFrame(null);
    setTarget(0);
    setError('');
    setLoading(true);
    setPlaying(false);
    void openReplay(source, { signal: controller.signal })
      .then((opened) => {
        if (!controller.signal.aborted) {
          setReplay(opened);
          if (opened.manifest.end.kind !== 'result') setLoading(false);
        }
      })
      .catch((error: unknown) => failed(error, controller.signal));
    return () => controller.abort();
  }, [source, failed]);
  useEffect(() => {
    if (!player) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void player
      .frame(target, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setFrame(next);
          setLoading(false);
        }
      })
      .catch((error: unknown) => failed(error, controller.signal));
    return () => controller.abort();
  }, [player, target, failed]);
  useEffect(() => {
    if (!playing || !replay) return;
    const anchor = cursor.current.target,
      started = performance.now();
    const end = replay.manifest.lastVerifiedStep ?? 0;
    let frame = 0;
    const tick = (now: number) => {
      if (!cursor.current.loading) {
        const next = playbackStep(anchor, now - started, speed, end);
        setTarget(next);
        if (next === end) {
          setPlaying(false);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const hidden = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [playing, speed, replay]);
  const end = replay?.manifest.end;
  const last = replay?.manifest.lastVerifiedStep ?? 0;
  return (
    <section ref={panel} tabIndex={-1} className="panel" aria-label="保存リプレイ">
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
          {end?.kind !== 'result' && <p role="status">再生なし: 診断のみを表示しています。</p>}
          {end?.kind === 'result' &&
            ['unresolved', 'truncated'].includes(end.result.outcome.kind) && (
              <p role="status">部分リプレイ: 記録された範囲まで再生できます。</p>
            )}
          {end?.kind === 'result' && (
            <>
              {model && (
                <SceneBoundary
                  key={`scene:${replay.manifest.simulationHash}`}
                  fallback={<Scene2D model={model} overlays={overlays} />}
                >
                  <Suspense fallback={<p>3D表示を準備しています</p>}>
                    <Scene model={model} cameraMode={cameraMode} overlays={overlays} />
                  </Suspense>
                </SceneBoundary>
              )}
              <div className="actions">
                <button
                  disabled={!playing && (loading || target >= last)}
                  onClick={() => setPlaying((value) => !value)}
                >
                  {playing ? '一時停止' : '再生'}
                </button>
                <button onClick={() => seek(0)}>先頭へ</button>
                <label>
                  再生速度
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                    <option value="0.5">0.5倍</option>
                    <option value="1">1倍</option>
                    <option value="2">2倍</option>
                    <option value="4">4倍</option>
                  </select>
                </label>
                <label>
                  カメラ
                  <select
                    value={cameraMode}
                    onChange={(e) => setCameraMode(e.target.value as CameraMode)}
                  >
                    <option value="overview">全体</option>
                    <option value="side">横</option>
                    <option value="follow">追従</option>
                    <option value="free">自由</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={overlays}
                    onChange={(e) => setOverlays(e.target.checked)}
                  />
                  記録された軌跡・命中点と形状を表示
                </label>
              </div>
              <label>
                表示step
                <input
                  type="range"
                  min="0"
                  max={last}
                  value={target}
                  onChange={(e) => seek(Number(e.target.value))}
                />
              </label>
              <div className="actions">
                <label>
                  表示stepを入力
                  <input
                    type="number"
                    min="0"
                    max={last}
                    value={target}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isInteger(value) && value >= 0 && value <= last) seek(value);
                    }}
                  />
                </label>
                <button disabled={!target} onClick={() => seek(target - 1)}>
                  1step戻る
                </button>
                <button disabled={target >= last} onClick={() => seek(target + 1)}>
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
              {frame && (
                <CurrentEvents
                  key={state?.step}
                  events={frame.events}
                  step={state!.step}
                  onSeek={seek}
                />
              )}
              {player && (
                <ReplayEvents
                  key={`events:${replay.manifest.simulationHash}`}
                  replay={replay}
                  player={player}
                  step={state?.step ?? 0}
                  onSeek={seek}
                />
              )}
            </>
          )}
          <details>
            <summary>保存結果のhash</summary>
            <p>
              ファイルのchecksumは破損検出用です。公式結果の真正性を保証するものではありません。
            </p>
            <pre aria-label="保存結果のhash">
              {JSON.stringify(end?.kind === 'result' ? end.result : end, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
