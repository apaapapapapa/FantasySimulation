import { describe, expect, it } from 'vite-plus/test';
import { sampleCatalog } from '../packages/engine/src/spatial/catalog.ts';
import { assertPublishedRevisions } from './catalog-history.ts';

describe('published catalog immutability', () => {
  it('retains the previous inventory and adds explicit surveyed scenario IDs', async () => {
    const catalog = await sampleCatalog();
    await expect(assertPublishedRevisions(catalog)).resolves.toBeUndefined();
    for (const id of ['flat', 'pillars']) {
      const old = catalog.find((r) => r.kind === 'scenario' && r.id === id)!;
      const current = catalog.find((r) => r.id === `${id}-surveyed-v1`)!;
      expect(current.definition).toEqual(old.definition);
      expect(current.definition).toHaveProperty('terrainKnowledge', 'surveyed');
    }
  });
  it.each(['content', 'revision', 'remove', 'duplicate'] as const)(
    'rejects an existing sample %s change',
    async (change) => {
      const catalog = await sampleCatalog();
      const item = catalog[0]!;
      switch (change) {
        case 'content':
          item.definition.name = 'Changed';
          break;
        case 'revision':
          item.revision++;
          break;
        case 'remove':
          catalog.shift();
          break;
        case 'duplicate':
          catalog.push(structuredClone(item));
          break;
      }
      await expect(assertPublishedRevisions(catalog)).rejects.toThrow(/Published sample|Duplicate/);
    },
  );
});
