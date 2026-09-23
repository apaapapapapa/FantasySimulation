import { IdSchema } from '@fantasy/domain/spatial';

type Kind = 'drafts' | 'jobs';
export function recentIdentities(kind: Kind): string[] {
  try {
    return IdSchema.array()
      .max(20)
      .parse(JSON.parse(localStorage.getItem(`fantasy.recent-${kind}`) ?? '[]'));
  } catch {
    return [];
  }
}
export function rememberIdentity(kind: Kind, id: string, previous: string[]) {
  const next = [IdSchema.parse(id), ...previous.filter((value) => value !== id)].slice(0, 20);
  try {
    localStorage.setItem(`fantasy.recent-${kind}`, JSON.stringify(next));
  } catch {
    // Displayed IDs remain usable through the explicit ID input without browser storage.
  }
  return next;
}
