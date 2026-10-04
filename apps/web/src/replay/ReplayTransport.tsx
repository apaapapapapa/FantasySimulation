import type { CSSProperties } from 'react';
import { shareTimeLabel } from './share.ts';

type IconName = 'play' | 'pause' | 'restart' | 'back' | 'next';
const ICONS: Record<IconName, string> = {
  play: 'M8 5 19 12 8 19Z',
  pause: 'M8 5V19M16 5V19',
  restart: 'M5 5V19M19 5 8 12 19 19Z',
  back: 'M15 6 9 12 15 18',
  next: 'M9 6 15 12 9 18',
};

function TransportIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d={ICONS[name]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Controls seek through recorded steps; presentation never advances the simulation. */
export function ReplayTransport({
  target,
  shown,
  last,
  stepMs,
  playing,
  loading,
  repeat,
  speed,
  onSeek,
  onPlaying,
  onRepeat,
  onSpeed,
}: {
  target: number;
  shown: number | undefined;
  last: number;
  stepMs: number;
  playing: boolean;
  loading: boolean;
  repeat: boolean;
  speed: number;
  onSeek(step: number): void;
  onPlaying(): void;
  onRepeat(value: boolean): void;
  onSpeed(value: number): void;
}) {
  return (
    <div className="replay-transport" aria-label="再生操作">
      <div className="timeline-caption">
        <span className="eyebrow">TIMELINE</span>
        <span className="replay-time">
          <output aria-label="表示時刻">
            {shown === undefined ? '—' : shareTimeLabel(shown, stepMs)}
          </output>
          <span> / {shareTimeLabel(last, stepMs)}</span>
        </span>
      </div>
      <label className="replay-timeline">
        <span className="visually-hidden">表示step</span>
        <input
          type="range"
          min="0"
          max={last}
          value={target}
          style={{ '--replay-progress': `${last ? (target / last) * 100 : 0}%` } as CSSProperties}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </label>
      <div className="transport-row">
        <div className="transport-buttons">
          <button
            className="transport-icon"
            aria-label="先頭へ"
            title="先頭へ"
            onClick={() => onSeek(0)}
          >
            <TransportIcon name="restart" />
          </button>
          <button
            className="transport-icon"
            aria-label="1step戻る"
            title="1step戻る"
            disabled={!target}
            onClick={() => onSeek(target - 1)}
          >
            <TransportIcon name="back" />
          </button>
          <button
            className="transport-play"
            disabled={!playing && (loading || last === 0 || (!repeat && target >= last))}
            onClick={onPlaying}
          >
            <TransportIcon name={playing ? 'pause' : 'play'} />
            {playing ? '一時停止' : '再生'}
          </button>
          <button
            className="transport-icon"
            aria-label="1step進む"
            title="1step進む"
            disabled={target >= last}
            onClick={() => onSeek(target + 1)}
          >
            <TransportIcon name="next" />
          </button>
        </div>
        <div className="transport-options">
          <label className="repeat-toggle">
            <input
              type="checkbox"
              checked={repeat}
              disabled={last === 0}
              onChange={(event) => onRepeat(event.target.checked)}
            />
            繰り返し再生
          </label>
          <label className="speed-select">
            <span className="visually-hidden">再生速度</span>
            <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
              {[0.5, 1, 2, 4].map((value) => (
                <option key={value} value={value}>
                  {value}倍
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="transport-precision">
        <span>
          表示中のstep: <output aria-label="現在のstep">{shown ?? '—'}</output> / {last}
        </span>
        <label>
          表示stepを入力
          <input
            type="number"
            min="0"
            max={last}
            value={target}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= last) onSeek(value);
            }}
          />
        </label>
      </div>
    </div>
  );
}
