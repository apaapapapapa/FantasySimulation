import type { Definition, Manifest, StreamRecord } from '@fantasy/domain/spatial';
import { prepareBattle, reference } from '../src/spatial/prepare.ts';
import { sealRevision, ManifestBuilder } from '../src/spatial/manifest-builder.ts';
import { sampleManifest } from '@fantasy/samples';

type Scenario = Definition<'scenario'>;
export type BoxObstacle = Extract<Scenario['obstacles'][number], { kind: 'box' }>;

/** Fresh data on every call: tests may edit their own inputs without leaking state. */
export function boxObstacle(
  id: string,
  center: BoxObstacle['center'],
  halfExtents: BoxObstacle['halfExtents'],
): BoxObstacle {
  return {
    id,
    kind: 'box',
    center: { ...center },
    halfExtents: { ...halfExtents },
    yawMilliDegrees: 0,
    slopeMilliDegrees: 0,
    blocks: { movement: true, vision: true, attack: true },
  };
}
export function glassWall(halfThicknessMm: number): BoxObstacle {
  return {
    ...boxObstacle('glass', { x: 0, y: 2000, z: 0 }, { x: halfThicknessMm, y: 2000, z: 2000 }),
    blocks: { movement: true, vision: false, attack: true },
  };
}

/** Replace only the selected scenario and reseal its reference, not unrelated revisions. */
export async function editScenario(manifest: Manifest, edit: (definition: Scenario) => void) {
  const old = manifest.revisions.find(
    (r) =>
      r.kind === 'scenario' &&
      r.id === manifest.scenario.id &&
      r.revision === manifest.scenario.revision &&
      r.contentHash === manifest.scenario.contentHash,
  );
  if (!old || old.kind !== 'scenario') throw new Error('Missing fixture scenario');
  const definition = structuredClone(old.definition);
  edit(definition);
  const replacement = await sealRevision('scenario', old.id, old.revision, definition);
  manifest.revisions = manifest.revisions.map((r) => (r === old ? replacement : r));
  manifest.scenario = reference(replacement);
}

export async function terrainBattle(
  obstacles: Scenario['obstacles'] = [],
  mutate?: (manifest: Manifest) => void,
) {
  const manifest = await sampleManifest();
  await editScenario(manifest, (scenario) =>
    scenario.obstacles.push(...structuredClone(obstacles)),
  );
  mutate?.(manifest);
  return prepareBattle(manifest);
}

/** Shared sealing/wiring only; each test keeps its behavior-specific values and assertions. */
export async function combatManifest(
  maxSteps: number,
  edit: {
    ability?: Partial<Definition<'ability'>>;
    policy?: Partial<Definition<'policy'>>;
    character?: Partial<Definition<'character'>>;
    ids?: { ability: string; policy: string; character: string };
  } = {},
): Promise<Manifest> {
  const manifest = await sampleManifest(maxSteps);
  const baseAbility = manifest.revisions.find((r) => r.kind === 'ability')!;
  const ability = await sealRevision(
    'ability',
    edit.ids?.ability ?? baseAbility.id,
    baseAbility.revision,
    {
      ...baseAbility.definition,
      ...edit.ability,
    },
  );
  const basePolicy = manifest.revisions.find((r) => r.kind === 'policy')!;
  const policy = await sealRevision(
    'policy',
    edit.ids?.policy ?? basePolicy.id,
    basePolicy.revision,
    {
      ...basePolicy.definition,
      ...edit.policy,
    },
  );
  const baseCharacter = manifest.revisions.find((r) => r.kind === 'character')!;
  const character = await sealRevision(
    'character',
    edit.ids?.character ?? baseCharacter.id,
    baseCharacter.revision,
    {
      ...baseCharacter.definition,
      ...edit.character,
    },
  );
  return ManifestBuilder.relink(manifest, [
    { from: baseAbility, to: ability },
    { from: basePolicy, to: policy },
    { from: baseCharacter, to: character },
  ]);
}

export const battleEvents = (records: readonly StreamRecord[]) =>
  records.flatMap((record) => ('events' in record ? record.events : []));
