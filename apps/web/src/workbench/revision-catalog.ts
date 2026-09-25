import type { Revision } from '@fantasy/domain/spatial';
import { apiRevisionPage, executableRules } from '../api-client.ts';
export async function loadRevisionCatalog(signal: AbortSignal) {
  async function pages(kind: string) {
    const items: Revision[] = [];
    let cursor: string | null = null;
    let received = 0;
    const seen = new Set<string>();
    do {
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 100) throw new Error('設定一覧のページ参照が不正です');
        seen.add(cursor);
      }
      const page = await apiRevisionPage(kind, cursor, signal);
      received += page.items.length;
      items.push(...(kind === 'ruleset' ? executableRules(page) : page.items));
      cursor = page.nextCursor;
      if (received >= 1000 && cursor)
        throw new Error('設定が多すぎます。1000件以内のローカルDBを使用してください。');
    } while (cursor);
    return items;
  }
  return Promise.all([pages('character'), pages('ruleset'), pages('scenario')]);
}
