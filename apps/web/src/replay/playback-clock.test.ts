import { expect, it } from 'vite-plus/test';
import { playbackStep } from './playback-clock.ts';
it('uses recording time at 10/60/144 fps and preserves the cursor when paused or resumed', () => {
  for (const fps of [10, 60, 144]) {
    const displayed = Array.from({ length: fps + 1 }, (_, i) =>
      playbackStep(20, (i * 1000) / fps, 1, 240),
    );
    expect(displayed[0]).toBe(20);
    expect(displayed.at(-1)).toBe(70);
  }
  expect(playbackStep(40, 600, 2, 240)).toBe(100);
  expect(playbackStep(100, 0, 0.5, 240)).toBe(100);
  expect(playbackStep(200, 5000, 2, 240)).toBe(240);
});
