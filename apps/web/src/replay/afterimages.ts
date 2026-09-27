import { useState } from 'react';

export type Afterimage<T> = { item: T; step: number };

/**
 * Recorded marks from recently displayed steps fade out instead of vanishing after one frame.
 * Only already-shown items are kept; seeking backwards drops anything newer than `step`.
 */
export function retainAfterimages<T>(
  previous: readonly Afterimage<T>[],
  current: readonly T[],
  step: number,
  span: number,
): Afterimage<T>[] {
  return [
    ...previous.filter((mark) => mark.step < step && mark.step > step - span),
    ...current.map((item) => ({ item, step })),
  ];
}

/** 1 for the displayed step, falling linearly to 0 at `span` steps old. */
export const afterimageStrength = (mark: { step: number }, step: number, span: number) =>
  Math.max(0, 1 - (step - mark.step) / span);

/**
 * Display memory of the frames this viewer has shown. `frame` identifies the displayed frame
 * (the scene model), so re-rendering one frame never ages or duplicates its marks.
 */
export function useAfterimages<T>(
  frame: object,
  current: readonly T[],
  step: number,
  span: number,
) {
  const [memory, setMemory] = useState(() => ({
    frame,
    marks: retainAfterimages<T>([], current, step, span),
  }));
  if (memory.frame === frame) return memory.marks;
  const next = { frame, marks: retainAfterimages(memory.marks, current, step, span) };
  setMemory(next);
  return next.marks;
}
