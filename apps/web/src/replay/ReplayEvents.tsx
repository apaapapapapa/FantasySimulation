import { useEffect, useState } from 'react';
import { StreamRecordSchema, type BattleEvent } from '@fantasy/domain/spatial';
import type { OpenedReplay } from './open-replay.ts';
import { errorText } from '../api-client.ts';

export function ReplayEvents({
  replay,
  onSeek,
}: {
  replay: OpenedReplay;
  onSeek(step: number): void;
}) {
  const [chunk, setChunk] = useState(0),
    [page, setPage] = useState(0);
  const [events, setEvents] = useState<BattleEvent[]>([]),
    [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setEvents([]);
    setError('');
    setPage(0);
    const ref = replay.manifest.chunks[chunk];
    if (ref)
      void (async () => {
        await replay.seek(ref.firstRecord + ref.records, controller.signal);
        const records = await replay.records(chunk, controller.signal);
        const all = records.flatMap((raw) => {
          const record = StreamRecordSchema.parse(raw);
          return 'events' in record ? record.events : [];
        });
        if (!controller.signal.aborted) setEvents(all);
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [replay, chunk, expanded]);
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
        {events.slice(page * 50, (page + 1) * 50).map((event) => (
          <li key={event.id}>
            <button onClick={() => onSeek(event.step)}>
              step {event.step}へ: {event.id} {event.kind}
            </button>
            <details>
              <summary>
                {event.cognition ? 'AIの観測・判断（主観）' : '確定イベント'} · {event.ruleId}
              </summary>
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </details>
          </li>
        ))}
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
