import type { Definition, Manifest, Revision } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';
import { reference, sealRevision } from '../src/spatial/prepare.ts';
import { revisionClosure } from '../src/spatial/catalog.ts';

/** Sealing/wiring for real reaction battles; no expected outcomes live in this factory. */
export async function reactionManifest(options: {
  reactions: Partial<Definition<'ability'>>[];
  steps?: number;
  attack?: Partial<Definition<'ability'>>;
  character?: Partial<Definition<'character'>>;
  leftReactions?: boolean;
  rightAttack?: boolean;
  revisions?: Revision[];
}): Promise<Manifest> {
  const manifest = await combatManifest(options.steps ?? 40, {
    ids: {
      ability: 'reaction-primary',
      policy: 'reaction-fixture-policy',
      character: 'reaction-fixture-base',
    },
    ability: {
      attack: { kind: 'hitscan', radiusMm: 0 },
      castSteps: 0,
      recoverySteps: 1,
      cooldownSteps: 0,
      condition: { kind: 'always' },
      rangeMm: 20000,
      aimErrorMilliDegrees: 0,
      costs: { hp: 0, mp: 0, uses: 1 },
      effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' }],
      ...options.attack,
    },
    policy: { movement: 'hold' },
    ...(options.character ? { character: options.character } : {}),
  });
  const primary = manifest.revisions.find((r) => r.kind === 'ability')!;
  const { stages: _, ...reactionBase } = primary.definition;
  const reactions = await Promise.all(
    options.reactions.map((edit, i) =>
      sealRevision('ability', `reaction-${i}`, 1, {
        ...reactionBase,
        name: `reaction ${i}`,
        trigger: 'before-hit',
        target: 'self',
        attack: { kind: 'direct' },
        rangeMm: 0,
        costs: { hp: 0, mp: 0, uses: 0 },
        effects: [],
        reaction: { response: { kind: 'parry', scope: 'all' } },
        ...edit,
      }),
    ),
  );
  const base = manifest.revisions.find((r) => r.kind === 'character')!;
  manifest.revisions.push(...reactions, ...(options.revisions ?? []));
  for (const [index, participant] of manifest.participants.entries()) {
    const primaryRefs = index === 1 && options.rightAttack === false ? [] : [reference(primary)];
    const basePolicy = manifest.revisions.find((r) => r.kind === 'policy')!;
    const policy = await sealRevision('policy', `reactor-policy-${index}`, 1, {
      ...basePolicy.definition,
      priorities: primaryRefs.length ? basePolicy.definition.priorities : [],
    });
    manifest.revisions.push(policy);
    const character = await sealRevision('character', `reactor-${index}`, 1, {
      ...base.definition,
      policy: reference(policy),
      abilities: [
        ...primaryRefs,
        ...(index === 0 && options.leftReactions === false ? [] : reactions.map(reference)),
      ],
    });
    manifest.revisions.push(character);
    participant.character = reference(character);
  }
  manifest.revisions = revisionClosure(manifest.revisions, [
    ...manifest.participants.map((p) => ({ kind: 'character' as const, ref: p.character })),
    { kind: 'scenario', ref: manifest.scenario },
    { kind: 'ruleset', ref: manifest.ruleset },
  ]);
  return manifest;
}
