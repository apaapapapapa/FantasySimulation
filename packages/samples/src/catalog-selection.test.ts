import { expect, it } from 'vite-plus/test';
import { revisionReference } from '@fantasy/domain/spatial';
import { sealRevision } from '@fantasy/engine/spatial';
import { sampleCatalog, uniqueCatalogRevision } from './catalog.ts';

it('requires exact refs after an immutable catalog ID gains another revision', async () => {
  const catalog = await sampleCatalog(),
    base = uniqueCatalogRevision(catalog, 'ability', 'sword'),
    replacement = await sealRevision('ability', base.id, base.revision + 1, {
      ...base.definition,
      name: 'Versioned selection fixture',
    }),
    revisions = [...catalog, replacement];

  expect(revisionReference(base)).not.toEqual(revisionReference(replacement));
  expect(() => uniqueCatalogRevision(revisions, 'ability', base.id)).toThrow(
    'Ambiguous catalog entry: ability:sword',
  );
  expect(() => uniqueCatalogRevision(revisions, 'ability', 'missing')).toThrow(
    'Unknown catalog entry: ability:missing',
  );
});
