import { deepFreeze } from '@fantasy/domain';
import type { SkillCatalogRelease } from './skill-catalog-releases.ts';
import releases from './startup-skill-catalog-history/releases.json' with { type: 'json' };
import v1 from './startup-skill-catalog-history/v1.json' with { type: 'json' };
import v2 from './startup-skill-catalog-history/v2.json' with { type: 'json' };

const snapshots = new Map([
  [1, v1],
  [2, v2],
]);

/**
 * Frozen output of unchanged main 829e6e5d9b3b04a95f10ee6a126060723472629a.
 * Existing history goldens were checked before replacing the builders. v1 retains
 * its historical raw order; domain hashing/persistence retain their normalization.
 * v1/v2 are checkpoints, then exact one-node deltas. Never reconstruct these from
 * current authoring or edit them for a new recipe: append a reviewed release.
 * Registration here is not evidence of executed skill tests.
 */
export const STARTUP_SKILL_CATALOG_RELEASES: readonly SkillCatalogRelease[] = deepFreeze(
  releases.map((release): SkillCatalogRelease => {
    const { reference, parent, changedNodeIds } = release;
    if (release.kind === 'historical-snapshot')
      return {
        kind: 'historical-snapshot',
        reference,
        parent,
        changedNodeIds,
        catalog: snapshots.get(release.snapshotRevision!),
      };
    return { kind: 'delta', reference, parent, changedNodeIds, changes: release.changes! };
  }),
);
