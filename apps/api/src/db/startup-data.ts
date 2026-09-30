import type { Store } from './store.ts';
import { readSampleRevisions } from './store.ts';
import { SkillStore } from './skill-store.ts';
import { inspectStartupSkillCatalog, readStartupSkillCatalog } from './startup-skill-catalog.ts';

/** Seed immutable built-in definitions and the partial, explicitly unfinished skill catalog. */
export async function seedStartupData(store: Store) {
  const revisions = readSampleRevisions();
  await store.seedRevisions(revisions);
  const catalog = readStartupSkillCatalog(revisions),
    release = inspectStartupSkillCatalog(catalog, revisions),
    record = await new SkillStore(store).seedCatalog(catalog);
  return { skillCatalog: record, skillCatalogRelease: release };
}
