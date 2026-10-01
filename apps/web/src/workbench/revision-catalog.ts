import { revisionHash, type Revision } from '@fantasy/domain/spatial';
import { apiRevisionPage, executableRules } from '../api-client.ts';
export async function loadRevisionKind(kind: string, signal: AbortSignal) {
  const items: Revision[] = [];
  let cursor: string | null = null;
  let received = 0;
  const seen = new Set<string>();
  const identities = new Map<string, { contentHash: string; serialized: string }>();
  do {
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 100) throw new Error('設定一覧のページ参照が不正です');
      seen.add(cursor);
    }
    const page = await apiRevisionPage(kind, cursor, signal);
    received += page.items.length;
    const accepted = kind === 'ruleset' ? executableRules(page) : page.items;
    for (const revision of page.items) {
      const identity = `${revision.kind}:${revision.id}:${revision.revision}`;
      if (revision.contentHash !== (await revisionHash(revision)))
        throw new Error(`Revision content hash mismatch: ${identity}`);
      const serialized = JSON.stringify(revision);
      const prior = identities.get(identity);
      if (prior && (prior.contentHash !== revision.contentHash || prior.serialized !== serialized))
        throw new Error(`Conflicting duplicate revision: ${identity}`);
      if (prior) continue;
      identities.set(identity, { contentHash: revision.contentHash, serialized });
      if (accepted.includes(revision)) items.push(revision);
    }
    cursor = page.nextCursor;
    if (received >= 1000 && cursor)
      throw new Error('設定が多すぎます。1000件以内のローカルDBを使用してください。');
  } while (cursor);
  return items;
}

export async function loadRevisionCatalog(signal: AbortSignal) {
  return Promise.all([
    loadRevisionKind('character', signal),
    loadRevisionKind('ruleset', signal),
    loadRevisionKind('scenario', signal),
  ]);
}
