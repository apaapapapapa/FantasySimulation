import { publicHashName } from '@fantasy/domain/spatial';

export function matchLink(setHash: string, page: number, slotId?: string) {
  if (!Number.isInteger(page) || page < 0 || page > 9) throw new Error('Invalid public page');
  return `#/sets/${publicHashName(setHash)}/pages/${page}${slotId ? `/matches/${publicHashName(slotId)}` : ''}`;
}

export function readMatchRoute(value: string) {
  if (!value || value === '#/') return { setHash: null, page: 0, slotId: null, error: '' };
  const found = /^#\/sets\/([0-9a-f]{64})\/pages\/([0-9])(?:\/matches\/([0-9a-f]{64}))?$/.exec(
    value,
  );
  return found
    ? {
        setHash: `sha256:${found[1]}`,
        page: Number(found[2]),
        slotId: found[3] ? `sha256:${found[3]}` : null,
        error: '',
      }
    : { setHash: null, page: 0, slotId: null, error: 'リプレイURLの形式が不正です' };
}
