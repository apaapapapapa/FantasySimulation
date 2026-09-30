import type { Store } from './store.ts';
import { readSampleRevisions } from './store.ts';
import { SkillStore } from './skill-store.ts';
import {
  inspectIntegratedStartupSkillCatalog,
  readIntegratedStartupSkillCatalog,
  readIntegratedStartupSkillCatalogV2,
  readIntegratedStartupSkillCatalogV3,
  readPreviousIntegratedStartupSkillCatalog,
  readStartupSkillCatalog,
} from './startup-skill-catalog.ts';

/** Seed immutable built-in definitions and the partial, explicitly unfinished skill catalog. */
export async function seedStartupData(store: Store) {
  const revisions = readSampleRevisions();
  await store.seedRevisions(revisions);
  const skills = new SkillStore(store),
    legacy = readStartupSkillCatalog(revisions),
    integratedV2 = readIntegratedStartupSkillCatalogV2(revisions),
    integratedV3 = readIntegratedStartupSkillCatalogV3(revisions),
    previous = readPreviousIntegratedStartupSkillCatalog(revisions),
    catalog = readIntegratedStartupSkillCatalog(revisions),
    release = inspectIntegratedStartupSkillCatalog(catalog, revisions);
  await skills.seedCatalog(legacy);
  await skills.seedCatalog(integratedV2);
  await skills.seedCatalog(integratedV3);
  await skills.seedCatalog(previous);
  const record = await skills.seedCatalog(catalog);
  return { skillCatalog: record, skillCatalogRelease: release };
}
