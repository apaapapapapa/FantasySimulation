import type { Store } from './store.ts';
import { readSampleRevisions } from './store.ts';
import { SkillStore } from './skill-store.ts';
import {
  inspectIntegratedStartupSkillCatalog,
  readIntegratedStartupSkillCatalog,
  readPreviousIntegratedStartupSkillCatalog,
  readStartupSkillCatalog,
} from './startup-skill-catalog.ts';

/** Seed immutable built-in definitions and the partial, explicitly unfinished skill catalog. */
export async function seedStartupData(store: Store) {
  const revisions = readSampleRevisions();
  await store.seedRevisions(revisions);
  const skills = new SkillStore(store),
    legacy = readStartupSkillCatalog(revisions),
    previous = readPreviousIntegratedStartupSkillCatalog(revisions),
    catalog = readIntegratedStartupSkillCatalog(revisions),
    release = inspectIntegratedStartupSkillCatalog(catalog, revisions);
  await skills.seedCatalog(legacy);
  await skills.seedCatalog(previous);
  const record = await skills.seedCatalog(catalog);
  return { skillCatalog: record, skillCatalogRelease: release };
}
