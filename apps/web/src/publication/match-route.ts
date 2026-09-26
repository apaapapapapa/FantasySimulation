import { MAX_BATTLE_STEPS, publicHashName } from '@fantasy/domain/spatial';

/** `/steps/N` pins the displayed step of a shared replay link; N is a recorded step. */
export function stepSuffix(step: number | null | undefined) {
  if (step === null || step === undefined) return '';
  if (!Number.isInteger(step) || step < 0 || step > MAX_BATTLE_STEPS)
    throw new Error('Invalid replay step');
  return `/steps/${step}`;
}
export const STEP_PATTERN = '(?:\\/steps\\/(0|[1-9][0-9]{0,4}))?';
export function readStep(value: string | undefined) {
  if (value === undefined) return null;
  const step = Number(value);
  return step <= MAX_BATTLE_STEPS ? step : undefined;
}

export function matchLink(setHash: string, page: number, slotId?: string, step?: number | null) {
  if (!Number.isInteger(page) || page < 0 || page > 9) throw new Error('Invalid public page');
  if (step != null && !slotId) throw new Error('A step link requires a match');
  return `#/sets/${publicHashName(setHash)}/pages/${page}${slotId ? `/matches/${publicHashName(slotId)}` : ''}${stepSuffix(step)}`;
}

export function readMatchRoute(value: string) {
  if (!value || value === '#/')
    return { setHash: null, page: 0, slotId: null, step: null, error: '' };
  const found = new RegExp(
    `^#\\/sets\\/([0-9a-f]{64})\\/pages\\/([0-9])(?:\\/matches\\/([0-9a-f]{64})${STEP_PATTERN})?$`,
  ).exec(value);
  const step = readStep(found?.[4]);
  return found && step !== undefined
    ? {
        setHash: `sha256:${found[1]}`,
        page: Number(found[2]),
        slotId: found[3] ? `sha256:${found[3]}` : null,
        step,
        error: '',
      }
    : { setHash: null, page: 0, slotId: null, step: null, error: 'リプレイURLの形式が不正です' };
}
