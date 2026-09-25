import { AI_RULES, type Definition, type Revision } from '@fantasy/domain/spatial';
import { sealRevision, reference, rulesExecutionEligibility } from '@fantasy/engine/spatial';
import { evaluationRules } from './published-rules.ts';

/** Issue #45 numerical proposal. Review its fixtures before authorizing distribution. */
export const TACTICAL_AI: NonNullable<Definition<'ruleset'>['ai']> = {
  ...AI_RULES,
  slots: 'simultaneous-v1',
  minimumCandidateWeightBps: 500,
  relativeImpactBps: [2500, 7500, 12500],
  reapplication: 'self-observed-v1',
  groundEvasion: 'posture-jump-v1',
  search: {
    maxWaitSteps: 500,
    cellsPerSide: 5,
    revisitSteps: 500,
    lowSightMm: 100,
    goalTimeoutSteps: 150,
  },
};
export function tacticalPostures(
  body: Definition<'character'>['body'],
): NonNullable<Definition<'character'>['postures']> {
  const shape = (heightMm: number, eye: number) => ({
    ...body,
    heightMm,
    eyeOffset: { x: 0, y: eye, z: 0 },
    muzzleOffset: { x: 0, y: 0, z: 0 },
    aimOffset: { x: 0, y: 0, z: 0 },
  });
  return {
    crouching: { body: shape(1000, 350), speedBps: 5000, transitionSteps: 10 },
    prone: { body: shape(600, 100), speedBps: 2000, transitionSteps: 20 },
  };
}
export async function addTacticalSamples(revisions: Revision[]) {
  const rules = revisions.find(
    (r) => r.kind === 'ruleset' && rulesExecutionEligibility(r.definition).executable,
  )!;
  if (rules.kind !== 'ruleset') throw new Error('Missing current rules');
  revisions.push(
    {
      kind: 'ruleset',
      id: 'standard-tactics-v1',
      revision: 1,
      schemaVersion: 1,
      contentHash: 'sha256:b4b4af6be2ef0f4c1ad69d21013b6e0fd5f631b7a9ef61b168050e643bd79f99',
      definition: {
        ...evaluationRules.definition,
        name: '観測・索敵・姿勢',
        ai: { ...evaluationRules.definition.ai, ...TACTICAL_AI },
      },
    } satisfies Revision,
    await sealRevision('ruleset', 'standard-tactics-v2', 1, {
      ...rules.definition,
      name: '観測・索敵・姿勢・脅威時の遮蔽',
      ai: { ...rules.definition.ai!, ...TACTICAL_AI, cover: 'observed-threat-v1' },
    }),
  );
  for (const [base, id] of [
    ['archer', 'posture-archer-v1'],
    ['stamina-scout-v1', 'posture-duelist-v1'],
  ] as const) {
    const actor = revisions.find((r) => r.kind === 'character' && r.id === base)!;
    if (actor.kind !== 'character') throw new Error('Missing tactical base');
    const source = revisions.find(
      (r) => r.kind === 'policy' && r.id === actor.definition.policy.id,
    )!;
    if (source.kind !== 'policy') throw new Error('Missing tactical policy');
    const policy = await sealRevision('policy', `${id}-policy`, 1, {
      ...source.definition,
      name: `${source.definition.name}・姿勢と索敵`,
      evaluation: {
        attackBps: 10000,
        survivalBps: 10000,
        explorationBps: 10000,
        riskToleranceBps: 5000,
        resourceConservationBps: 15000,
        searchAggressionBps: 5000,
      },
    });
    revisions.push(
      policy,
      await sealRevision('character', id, 1, {
        ...actor.definition,
        name: `${actor.definition.name}・姿勢検証`,
        postures: tacticalPostures(actor.definition.body),
        policy: reference(policy),
      }),
    );
  }
  const pillars = revisions.find((r) => r.kind === 'scenario' && r.id === 'pillars-surveyed-v1')!;
  if (pillars.kind !== 'scenario') throw new Error('Missing surveyed terrain');
  revisions.push(
    await sealRevision('scenario', 'search-observed-v1', 1, {
      ...pillars.definition,
      name: '未観測の柱・索敵検証',
      terrainKnowledge: 'observed',
    }),
  );
  revisions.push(
    await sealRevision('scenario', 'cover-surveyed-v1', 1, {
      ...pillars.definition,
      name: '高低の遮蔽・索敵検証',
      obstacles: [
        ...pillars.definition.obstacles,
        ...[-1, 1].map((sign) => ({
          kind: 'box' as const,
          id: `low-cover-${sign < 0 ? 'west' : 'east'}`,
          center: { x: sign * 2500, y: 600, z: sign * 3000 },
          halfExtents: { x: 200, y: 600, z: 1200 },
          yawMilliDegrees: 0,
          slopeMilliDegrees: 0,
          blocks: { movement: true, vision: true, attack: true },
        })),
      ],
    }),
  );
}
