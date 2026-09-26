import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReplaySource } from './open-replay.ts';
import type { ReplayFrame } from './replay-player.ts';
import { openReplaySession, type ReplaySession } from './replay-session.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { replayErrorText as errorText } from './load-message.ts';
import { SceneBoundary } from './SceneBoundary.tsx';
import { playbackStep } from './playback-clock.ts';
import type { CameraMode, CameraNudge } from './Scene.tsx';
import { webglAvailable } from './webgl.ts';
import { shareTimeLabel } from './share.ts';
import { ReplayEvents, CurrentEvents } from './ReplayEvents.tsx';
import { NO_OVERLAYS, OVERLAY_LABELS } from './overlays.ts';
import { ReplayResources } from './ReplayResources.tsx';

const Scene = lazy(() => import('./Scene.tsx'));

type View = '3d' | '2d';
const NUDGES: [CameraNudge['kind'], string][] = [
  ['left', '左へ回す'],
  ['right', '右へ回す'],
  ['in', '近づく'],
  ['out', '離れる'],
];

export function ReplayPanel({
  source,
  local = false,
  initialStep = 0,
  stepLink,
}: {
  source: ReplaySource;
  /** A viewer-chosen file: never presented as a published match or an official ranking. */
  local?: boolean;
  /** Step requested by a shared link; applied once when this source opens. */
  initialStep?: number;
  /** Shareable URL for the displayed step; omitted where no stable link exists. */
  stepLink?: (step: number) => string;
}) {
  const [replay, setReplay] = useState<ReplaySession | null>(null);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const state = frame?.checkpoint;
  const [target, setTarget] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');
  const [overlays, setOverlays] = useState(NO_OVERLAYS);
  const [webgl] = useState(webglAvailable);
  const [view, setView] = useState<View>(webgl ? '3d' : '2d');
  const [nudge, setNudge] = useState<CameraNudge | null>(null);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState('');
  const [notice, setNotice] = useState('');
  const requested = useRef(initialStep);
  const player = replay?.manifest.end.kind === 'result' ? replay : null;
  const model = useMemo(
    () =>
      replay && frame
        ? buildSceneModel(
            replay.context,
            frame.checkpoint,
            frame.records,
            frame.events,
            frame.eventRecords,
          )
        : null,
    [replay, frame],
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
    setNotice('');
    setLoading(true);
    setPlaying(false);
    void openReplaySession(source, controller.signal)
      .then((opened) => {
        if (!controller.signal.aborted) {
          const last = opened.manifest.lastVerifiedStep ?? 0,
            step = requested.current;
          if (step > last)
            setNotice(
              `リンクのstep ${step} は記録済み範囲 0–${last} の外です。先頭から表示します。`,
            );
          else if (opened.manifest.end.kind === 'result') setTarget(step);
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
    let anchor = cursor.current.target;
    let started: number | undefined;
    const end = replay.manifest.lastVerifiedStep ?? 0;
    let frame = 0;
    const tick = (now: number) => {
      if (!cursor.current.loading) {
        if (cursor.current.target === end && repeat && end > 0) {
          // Show the loaded final frame before rewinding. Start the next clock
          // only once step 0 has loaded, so buffering cannot skip the opening.
          setTarget(0);
          anchor = 0;
          started = undefined;
        } else {
          started ??= now;
          const next = playbackStep(anchor, now - started, speed, end);
          setTarget(next);
          if (next === end && (!repeat || end === 0)) {
            setPlaying(false);
            return;
          }
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
  }, [playing, speed, replay, repeat]);
  const end = replay?.manifest.end;
  const last = replay?.manifest.lastVerifiedStep ?? 0;
  const shown = state?.step;
  const link =
    stepLink && shown !== undefined ? new URL(stepLink(shown), window.location.href).href : null;
  function camera(kind: CameraNudge['kind']) {
    if (view === '2d') {
      if (kind === 'in' || kind === 'out')
        setZoom((z) => Math.min(8, Math.max(1, kind === 'in' ? z * 1.5 : z / 1.5)));
      return;
    }
    setCameraMode('free');
    setNudge((previous) => ({ kind, seq: (previous?.seq ?? 0) + 1 }));
  }
  const flat = model && (
    <Scene2D
      model={model}
      overlays={overlays}
      zoom={zoom}
      focus={cameraMode === 'follow' ? model.follow : model.centre}
    />
  );
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className={local ? 'panel local-replay' : 'panel'}
      aria-label={local ? 'ローカルリプレイ' : '保存リプレイ'}
    >
      <h2>{local ? 'ローカルファイルのリプレイ' : '保存リプレイ'}</h2>
      {local && (
        <p role="note" className="message local-note">
          この端末で選んだファイルです。公開済みの試合・正式なランキングには含まれず、送信もしていません。checksumは破損検出用で、内容の真正性は確認していません。
        </p>
      )}
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
      {notice && (
        <p role="status" className="message error">
          {notice}
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
              {!webgl && (
                <p role="status" aria-label="描画状態">
                  WebGLを利用できないため、2Dの俯瞰図と時系列のログで表示しています。
                </p>
              )}
              {model &&
                (view === '2d' ? (
                  flat
                ) : (
                  <SceneBoundary key={`scene:${replay.manifest.simulationHash}`} fallback={flat}>
                    <Suspense fallback={<p>3D表示を準備しています</p>}>
                      <Scene
                        model={model}
                        cameraMode={cameraMode}
                        overlays={overlays}
                        nudge={nudge}
                      />
                    </Suspense>
                  </SceneBoundary>
                ))}
              <div className="actions" aria-label="カメラ操作">
                <label>
                  表示
                  <select value={view} onChange={(e) => setView(e.target.value as View)}>
                    <option value="3d" disabled={!webgl}>
                      3D
                    </option>
                    <option value="2d">2D（俯瞰図）</option>
                  </select>
                </label>
                {NUDGES.map(([kind, label]) => (
                  <button
                    key={kind}
                    disabled={view === '2d' && (kind === 'left' || kind === 'right')}
                    onClick={() => camera(kind)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="actions">
                <button
                  disabled={!playing && (loading || last === 0 || (!repeat && target >= last))}
                  onClick={() => setPlaying((value) => !value)}
                >
                  {playing ? '一時停止' : '再生'}
                </button>
                <button onClick={() => seek(0)}>先頭へ</button>
                <label>
                  <input
                    type="checkbox"
                    checked={repeat}
                    disabled={last === 0}
                    onChange={(e) => setRepeat(e.target.checked)}
                  />
                  繰り返し再生
                </label>
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
                {(Object.keys(OVERLAY_LABELS) as (keyof typeof OVERLAY_LABELS)[]).map((key) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={overlays[key]}
                      onChange={(e) =>
                        setOverlays((previous) => ({ ...previous, [key]: e.target.checked }))
                      }
                    />
                    {OVERLAY_LABELS[key]}
                  </label>
                ))}
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
                {shown !== undefined && (
                  <>
                    {' '}
                    / 表示時刻{' '}
                    <output aria-label="表示時刻">
                      {shareTimeLabel(shown, replay.manifest.profile.stepMs)}
                    </output>
                  </>
                )}
              </p>
              {link && (
                <p className="share">
                  <a href={link} aria-label="この場面へのリンク">
                    この場面（step {shown}）へのリンク
                  </a>{' '}
                  <button
                    onClick={() => {
                      // Clipboard access can be absent or denied; the link stays selectable.
                      if (!navigator.clipboard) return;
                      void navigator.clipboard
                        .writeText(link)
                        .then(() => setCopied(link))
                        .catch(() => setCopied(''));
                    }}
                  >
                    リンクをコピー
                  </button>
                  {copied === link && <span role="status"> コピーしました</span>}
                </p>
              )}
              <p>
                色付きの身体・効果の印と、白線の判定形状を分けて表示します。視野は遮蔽判定前の定義上の範囲です。
              </p>
              {overlays.vision && model?.actors.some((actor) => !actor.vision) && (
                <p>
                  視野補正を持つ状態の主体は、補正後の視野が記録されていないため視野を描画しません。
                </p>
              )}
              {state && <ReplayResources context={replay.context} checkpoint={state} />}
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
