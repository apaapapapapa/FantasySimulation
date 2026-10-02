import { expect, it } from 'vite-plus/test';
import { revisionReference } from '@fantasy/domain/spatial';
import { sealRevision } from '@fantasy/engine/spatial';
import { sampleCatalog, uniqueCatalogRevision } from '@fantasy/samples';
import { openStore } from './store.ts';

it('adds an exact newer immutable revision to an existing database', async () => {
  const base = uniqueCatalogRevision(await sampleCatalog(), 'ability', 'sword'),
    replacement = await sealRevision('ability', base.id, base.revision + 1, {
      ...base.definition,
      name: 'Versioned import fixture',
    }),
    conflictingBase = await sealRevision('ability', base.id, base.revision, {
      ...base.definition,
      name: 'Existing imported fixture',
    }),
    store = openStore(':memory:');
  try {
    await store.seedRevisions([base]);
    await store.seedExactRevisions([conflictingBase, replacement]);

    expect(store.requireRevision('ability', revisionReference(base))).toEqual(base);
    expect(store.requireRevision('ability', revisionReference(replacement))).toEqual(replacement);
    expect(store.listRevisions('ability').items).toEqual([replacement]);
  } finally {
    store.close();
  }
});
