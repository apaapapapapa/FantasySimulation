import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BattleEvent } from '@fantasy/domain/spatial';
import { EventEntries } from '../src/replay/EventEntries.tsx';

/** Browser-layer test adapter accepts shared records, never server or engine internals. */
export function renderCapabilityEvents(events: readonly BattleEvent[], step: number) {
  return renderToStaticMarkup(createElement(EventEntries, { events, step, onSeek: () => {} }));
}
