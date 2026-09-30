import { expect, it } from 'vite-plus/test';
import type { ReplayContext } from '@fantasy/domain/spatial';
import { skillProvenance } from './SkillProvenance.tsx';

it('projects immutable catalog, loadout and resolution identities from replay participants', () => {
  const receipt = {
    schemaVersion: 1 as const,
    resolverVersion: 'skill-resolver-v1' as const,
    catalog: { id: 'catalog', revision: 2, contentHash: `sha256:${'a'.repeat(64)}` },
    loadout: { id: 'loadout', revision: 3, contentHash: `sha256:${'b'.repeat(64)}` },
    explicitlyEnabledNodeIds: ['sword-rat-1'],
    resolvedNodeIds: ['sword-rat-1'],
    nodeResolutions: [
      {
        nodeId: 'sword-rat-1',
        resolution: [
          {
            kind: 'active-ability' as const,
            ability: { id: 'cut', revision: 1, contentHash: `sha256:${'c'.repeat(64)}` },
          },
        ],
      },
    ],
    resolutionDigest: `sha256:${'d'.repeat(64)}`,
  };
  const context = {
    actors: [{ participant: { actorId: 'left', skillLoadout: receipt } }],
  } as unknown as ReplayContext;
  expect(skillProvenance(context)).toEqual([{ actorId: 'left', ...receipt }]);
});
