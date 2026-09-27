import { expect, it } from 'vite-plus/test';
import { afterimageStrength, retainAfterimages, type Afterimage } from './afterimages.ts';

it('keeps recently displayed marks for the span and fades them linearly', () => {
  let marks: Afterimage<string>[] = [];
  for (const step of [1, 2, 3, 4, 5]) marks = retainAfterimages(marks, [`hit@${step}`], step, 3);
  expect(marks.map((m) => [m.item, m.step])).toEqual([
    ['hit@3', 3],
    ['hit@4', 4],
    ['hit@5', 5],
  ]);
  const strengths = marks.map((m) => afterimageStrength(m, 5, 3));
  [1 / 3, 2 / 3, 1].forEach((value, i) => expect(strengths[i]).toBeCloseTo(value, 12));
});

it('drops newer marks when seeking back and replaces a redisplayed step', () => {
  let marks: Afterimage<string>[] = [];
  for (const step of [10, 11, 12]) marks = retainAfterimages(marks, [`a${step}`], step, 5);
  marks = retainAfterimages(marks, ['b11'], 11, 5);
  expect(marks.map((m) => m.item)).toEqual(['a10', 'b11']);
  marks = retainAfterimages(marks, [], 11, 5);
  expect(marks.map((m) => m.item)).toEqual(['a10']);
  // A jump beyond the span shows only what that step recorded.
  expect(retainAfterimages(marks, ['c40'], 40, 5).map((m) => m.item)).toEqual(['c40']);
});
