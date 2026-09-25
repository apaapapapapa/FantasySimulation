import { describe, expect, it } from 'vite-plus/test';
import { sealRevision, reference } from '@fantasy/engine/spatial';
import { sampleCatalog } from '@fantasy/samples';
import { openStore } from './store.ts';

describe('persisted status transformations', () => {
  it('validates transformation references and atomically stores their immutable revision closure', async () => {
    const base = (await sampleCatalog()).find((r) => r.kind === 'status')!;
    const destination = await sealRevision('status', 'cooled', 1, {
      ...base.definition,
      stackKey: 'cooled',
      periodic: [],
    });
    const source = await sealRevision('status', 'heated', 1, {
      ...base.definition,
      reactions: [
        { element: 'water', response: { kind: 'transform', status: reference(destination) } },
      ],
    });
    const store = openStore(':memory:');
    try {
      await expect(store.loadPinnedRevisions([source])).rejects.toThrow(/Missing|mismatched/);
      expect(store.getRevision('status', 'heated')).toBeUndefined();
      await store.loadPinnedRevisions([source, destination]);
      expect(store.getRevision('status', 'heated')).toEqual(source);
      expect(store.getRevision('status', 'cooled')).toEqual(destination);
      const bad = store.createDraft({
        kind: 'status',
        definitionId: 'bad-transform',
        base: null,
        definition: {
          ...source.definition,
          reactions: [
            {
              element: 'water',
              response: { kind: 'transform', status: { ...reference(destination), revision: 2 } },
            },
          ],
        },
      });
      await expect(store.publishDraft(bad.id, bad.version)).rejects.toThrow(/Missing|mismatched/);
      expect(store.getRevision('status', 'bad-transform')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
