import { SkillPreviewRequestSchema, previewSkillSelection } from '@fantasy/domain';
import { requireSkillCatalog, characterSkillCapabilities } from './skill-records.ts';
import type { Store } from './store.ts';

/** Read-only: exact definitions/catalog only; never load or advance acquisition/loadout heads. */
export async function previewSkills(store: Store, input: unknown) {
  const proposal = SkillPreviewRequestSchema.parse(input),
    catalog = await requireSkillCatalog(store, proposal.catalog),
    capabilities = characterSkillCapabilities(store, proposal.character);
  return previewSkillSelection(catalog, proposal, capabilities, (kind, ref) =>
    store.getRevision(kind, ref.id, ref.revision),
  );
}
