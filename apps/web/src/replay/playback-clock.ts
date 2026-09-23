/** A display cursor derived from elapsed time, never from the number of rendered frames. */
export function playbackStep(anchor: number, elapsedMs: number, speed: number, last: number) {
  return Math.min(last, anchor + Math.floor((Math.max(0, elapsedMs) * speed) / 20));
}
