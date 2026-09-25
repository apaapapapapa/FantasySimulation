import { useEffect, useState } from 'react';
import type { BattleEvent } from '@fantasy/domain/spatial';
import type { OpenedReplay } from './open-replay.ts';
import { replayErrorText as errorText } from './load-message.ts';
import type { ReplayPlayer } from './replay-player.ts';
import { EventEntries } from './EventEntries.tsx';

export function CurrentEvents({
  events,
  step,
  onSeek,
}: {
  events: readonly BattleEvent[];
  step: number;
  onSeek(step: number): void;
}) {
  const [page, setPage] = useState(0);
  const visible = events.slice(page * 50, (page + 1) * 50);
  return (
    <section aria-label="現在のstepのログ">
      <h3>step {step}のログ</h3>
      <p>AIの判断・知識は各主体の観測と推定による主観です。判定ログ（全知）とは異なります。</p>
      {(['判定ログ（全知）', 'AI判断ログ（主観）'] as const).map((label, i) => (
        <div key={label}>
          <h4>{label}</h4>
          <ul aria-label={label}>
            <EventEntries
              events={visible.filter((e) => Boolean(e.cognition) === Boolean(i))}
              step={step}
              onSeek={onSeek}
            />
          </ul>
        </div>
      ))}
      {!events.length && <p>このstepにイベントの記録はありません。</p>}
      {events.length > 50 && (
        <div className="actions">
          <button disabled={!page} onClick={() => setPage((n) => n - 1)}>
            同時刻の前の50件
          </button>
          <button disabled={(page + 1) * 50 >= events.length} onClick={() => setPage((n) => n + 1)}>
            同時刻の次の50件
          </button>
        </div>
      )}
    </section>
  );
}

export function ReplayEvents({
  replay,
  player,
  step,
  onSeek,
}: {
  replay: OpenedReplay;
  player: ReplayPlayer;
  step: number;
  onSeek(step: number): void;
}) {
  const [chunk, setChunk] = useState(0),
    [page, setPage] = useState(0);
  const [events, setEvents] = useState<BattleEvent[]>([]),
    [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const currentChunk = Math.max(
    0,
    replay.manifest.chunks.findLastIndex((c) => c.fromStep < step),
  );
  useEffect(() => {
    setChunk(currentChunk);
  }, [currentChunk]);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setEvents([]);
    setError('');
    setPage(0);
    const ref = replay.manifest.chunks[chunk];
    if (ref)
      void (async () => {
        const all = await player.events(chunk, controller.signal);
        if (!controller.signal.aborted) setEvents(all);
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [replay, player, chunk, expanded]);
  return (
    <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>イベントログを開く</summary>
      <label>
        ログの区間
        <select value={chunk} onChange={(e) => setChunk(Number(e.target.value))}>
          {replay.manifest.chunks.map((ref) => (
            <option key={ref.index} value={ref.index}>
              step {ref.fromStep}–{ref.toStep}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <ul aria-label="イベントログ">
        <EventEntries
          events={events.slice(page * 50, (page + 1) * 50)}
          step={step}
          onSeek={onSeek}
        />
      </ul>
      <div className="actions">
        <button disabled={!page} onClick={() => setPage((n) => n - 1)}>
          前の50イベント
        </button>
        <button disabled={(page + 1) * 50 >= events.length} onClick={() => setPage((n) => n + 1)}>
          次の50イベント
        </button>
      </div>
    </details>
  );
}
