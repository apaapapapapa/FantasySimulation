import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { StreamRecordSchema, type Definition, type Effect } from '@fantasy/domain/spatial';
import {
  aiFixture,
  impactEvidence,
  initialStatus,
  withInitialStatus,
} from '../../test-support/ai.ts';
import { battleEvents, combatManifest } from '../../test-support/fixtures.ts';
import { assessAbility, efficacy } from './ai/assessment.ts';
import { initializePhysics } from './world/physics.ts';
import { reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { sampleManifest } from '@fantasy/samples';
import { runBattle } from './run.ts';

beforeAll(initializePhysics);
const bladeEffects: Effect[] = [
  {
    kind: 'damage',
    amount: 3,
    attackScaleBps: 0,
    element: 'physical',
    defense: 'physical',
    scaling: [
      { stat: 'attack', ratioBps: 5000 },
      { stat: 'magicPower', ratioBps: 2500 },
    ],
  },
  {
    kind: 'damage',
    amount: 2,
    attackScaleBps: 0,
    element: 'fire',
    defense: 'magic',
    scaling: [
      { stat: 'attack', ratioBps: 2500 },
      { stat: 'magicPower', ratioBps: 5000 },
    ],
  },
];
const shapes: Definition<'ability'>['attack'][] = [
  { kind: 'melee', reachMm: 12000, radiusMm: 400, activeSteps: 2, maxHitsPerTarget: 1 },
  { kind: 'hitscan', radiusMm: 100 },
  {
    kind: 'projectile',
    speedMmPerSecond: 1000000,
    radiusMm: 100,
    lifetimeSteps: 100,
    gravityScaleBps: 0,
    homingTurnMilliDegreesPerSecond: 0,
    observation: 'launch-only',
    explosionRadiusMm: 0,
    maxHitsPerTarget: 1,
  },
];
async function swordFixture(attack: Definition<'ability'>['attack']) {
  const base = (await sampleManifest()).revisions.find((r) => r.kind === 'character')!.definition;
  const burning = await sealRevision(
    'status',
    'sword-burn',
    1,
    initialStatus({
      stackKey: 'sword-burn',
      durationSteps: 20,
      categories: ['damage-over-time'],
      burning: { waterExtinguishable: true },
      periodic: [{ kind: 'damage', amount: 8, element: 'fire', everySteps: 10 }],
    }),
  );
  const manifest = await combatManifest(50, {
    policy: { movement: 'hold' },
    character: {
      body: { ...base.body, muzzleOffset: { x: 0, y: 200, z: 0 } },
      stats: {
        ...base.stats,
        magicPower: 40,
        magicDefense: 12,
        shield: 7,
        resistances: { ...base.stats.resistances, fire: 2500 },
      },
    },
    ability: {
      name: 'burning magic sword',
      categories: ['physical', 'magic'],
      attack,
      castSteps: 0,
      rangeMm: 20000,
      costs: { hp: 0, mp: 0, uses: 1 },
      effects: [
        ...structuredClone(bladeEffects),
        { kind: 'apply-status', status: reference(burning) },
      ],
    },
  });
  manifest.revisions.push(burning);
  return manifest;
}

describe('new formulas in combat and observation (G-02)', () => {
  it.each(shapes)(
    'carries mixed power through $kind, records separate components and learns their defense basis',
    async (shape) => {
      const manifest = await swordFixture(shape);
      const run = await runBattle(manifest);
      const events = battleEvents(run.records);
      const damage = events.filter((e) => e.kind === 'damage' && e.actorId === 'left');
      expect(damage).toHaveLength(2);
      expect(
        damage.map((e) => [e.damage?.defenseApplied, e.amount, e.damage?.calculation]),
      ).toEqual([
        [
          5,
          18,
          {
            element: 'physical',
            component: 'physical',
            defense: 'physical',
            basePower: 23,
            afterModifiers: 18,
          },
        ],
        [
          12,
          11,
          {
            element: 'fire',
            component: 'elemental',
            defense: 'magic',
            basePower: 27,
            afterModifiers: 11,
          },
        ],
      ]);
      expect(damage.every((e) => e.after?.hp === 78 && e.after.shield === 0)).toBe(true);
      expect(
        events.some((e) => e.kind === 'status-apply' && e.reason.startsWith('sword-burn:')),
      ).toBe(true);
      const learned = events.flatMap((e) =>
        e.cognition?.kind === 'knowledge' ? e.cognition.learned : [],
      );
      expect(learned).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            element: 'physical',
            defense: 'physical',
            basePower: 23,
            kind: 'shield',
          }),
          expect.objectContaining({
            element: 'fire',
            defense: 'magic',
            basePower: 27,
            kind: 'shield',
          }),
        ]),
      );
      for (const record of run.records)
        expect(StreamRecordSchema.safeParse(record).success).toBe(true);
    },
  );
  it('reuses G-01 silence for a zero-MP mixed-stat sword', async () => {
    const manifest = await swordFixture(shapes[1]!);
    const abilityId = manifest.revisions.find((r) => r.kind === 'ability')!.id;
    await withInitialStatus(
      manifest,
      0,
      initialStatus({
        modifiers: {
          attack: 0,
          defense: 0,
          speedBps: 10000,
          flight: false,
          rooted: false,
          silenced: true,
        },
      }),
    );
    const events = battleEvents((await runBattle(manifest)).records);
    expect(
      events.some((e) => e.kind === 'launch' && e.actorId === 'left' && e.abilityId === abilityId),
    ).toBe(false);
    expect(
      events.some((e) => e.kind === 'launch' && e.actorId === 'right' && e.abilityId === abilityId),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.actorId === 'left' &&
          e.cognition?.kind === 'decision' &&
          e.cognition.excluded.some((x) => x.abilityId === abilityId && x.reason === 'silenced'),
      ),
    ).toBe(true);
  });
  it('values both own stats and keeps physical, magic and bypass experience separate', async () => {
    const f = await aiFixture({ abilities: [{ effects: structuredClone(bladeEffects) }] });
    try {
      const low = { ...f.view, magicPower: 0, burnDamage: 0 };
      const high = { ...low, magicPower: 200 };
      expect(assessAbility(high, f.abilities[0]!).weight).toBeGreaterThan(
        assessAbility(low, f.abilities[0]!).weight,
      );
      const view = {
        ...high,
        memory: {
          ...high.memory,
          knowledge: [
            impactEvidence(f.abilities[0]!, { range: { low: 0, high: 10 } }),
            impactEvidence(f.abilities[0]!, {
              eventId: 'magic',
              defense: 'magic',
              range: { low: 20, high: 30 },
            }),
          ],
        },
      };
      expect(efficacy(view, 'fire', 25, 'physical').bps).toBe(2000);
      expect(efficacy(view, 'fire', 25, 'magic').bps).toBe(10000);
      expect(efficacy(view, 'fire', 25, 'none')).toMatchObject({ confidence: 0, evidence: [] });
    } finally {
      f.world.free();
    }
  });
});
