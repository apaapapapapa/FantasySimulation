import type { Store } from './store.ts';
import { readSampleRevisions } from './store.ts';
import { SkillStore } from './skill-store.ts';
import {
  inspectIntegratedStartupSkillCatalog,
  readStartupSkillCatalogs,
} from './startup-skill-catalog.ts';

/** Seed immutable built-in definitions and the partial, explicitly unfinished skill catalog. */
export async function seedStartupData(store: Store) {
  const revisions = readSampleRevisions();
  // Startup definitions are immutable by exact revision; augments may add a newer revision
  // under a stable ability ID without rebinding existing characters or saved manifests.
  await store.seedExactRevisions(revisions);
  const skills = new SkillStore(store),
    catalogs = readStartupSkillCatalogs(revisions),
    catalog = catalogs.at(-1)!;
  const release = inspectIntegratedStartupSkillCatalog(catalog, revisions);
  let record;
  for (const released of catalogs) record = await skills.seedCatalog(released);
  if (!record) throw new Error('Startup skill catalog releases are missing');
  return { skillCatalog: record, skillCatalogRelease: release };
}
