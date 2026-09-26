import { NO_OVERLAYS } from '../src/replay/overlays.ts';
import { Scene2D } from '../src/replay/Scene2D.tsx';
import type { SceneModel } from '../src/replay/scene-model.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BattleEvent } from '@fantasy/domain/spatial';
import { EventEntries } from '../src/replay/EventEntries.tsx';

/** Browser-layer test adapter accepts shared records, never server or engine internals. */
export function renderCapabilityEvents(events: readonly BattleEvent[], step: number) {
  return renderToStaticMarkup(createElement(EventEntries, { events, step, onSeek: () => {} }));
}

export function renderCapabilityScene(model: SceneModel) {
  return renderToStaticMarkup(
    createElement(Scene2D, {
      model,
      overlays: NO_OVERLAYS,
    }),
  );
}
