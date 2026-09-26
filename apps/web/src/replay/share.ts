/** Recorded time of a step (display only; the link itself pins the step). */
export function shareTimeLabel(step: number, stepMs: number) {
  return `${((step * stepMs) / 1000).toFixed(2)}秒`;
}
