import { describe, expect, it, beforeAll } from 'vite-plus/test';
import { actorSeed, StreamRecordSchema } from '@fantasy/domain/spatial';
import { initializePhysics } from './world/physics.ts';
import { runBattle } from './run.ts';
import { aiFixture, flyingBody, initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { battleEvents, editScenario, glassWall } from '../../test-support/fixtures.ts';
import { catalogManifest } from '@fantasy/samples';

beforeAll(initializePhysics);
describe('common engine cognition and effects', () => {
  it('executes water only through cost/cast/effect boundaries and keeps burning while an attack is chosen', async () => {
    const f = await aiFixture({ steps: 35 });
    try {
      const burn = await withInitialStatus(
        f.manifest,
        0,
        initialStatus({
          burning: { waterExtinguishable: true },
          periodic: [{ kind: 'damage', amount: 10, element: 'fire', everySteps: 5 }],
        }),
      );
      const run = await runBattle(f.manifest),
        log = battleEvents(run.records);
      const water = log.find(
        (e) => e.actorId === 'left' && e.kind === 'launch' && e.abilityId === 'choice-1',
      );
      expect(water).toBeDefined();
      expect(
        log.some(
          (e) =>
            e.actorId === 'left' &&
            e.kind === 'status-remove' &&
            e.reason === `${burn.id}:dispel-existing` &&
            e.step === water!.step + 1,
        ),
      ).toBe(true);
      expect(
        log.some(
          (e) =>
            e.kind === 'damage' &&
            e.actorId === null &&
            e.targetId === 'left' &&
            e.step <= water!.step,
        ),
      ).toBe(true);
      const costs = log.filter(
        (e) => e.actorId === 'left' && e.kind === 'cost' && e.abilityId === 'choice-1',
      );
      expect(costs).toHaveLength(1);
      expect(costs[0]!.before!.mp - costs[0]!.after!.mp).toBe(4);
      // Seed 4 chooses an attack at the first observation despite ordinary burning.
      f.manifest.seed = 4;
      for (const p of f.manifest.participants) p.rngSeed = actorSeed(4, p.rngStream);
      const attacking = await runBattle(f.manifest),
        attackLog = battleEvents(attacking.records);
      const attack = attackLog.find(
        (e) => e.actorId === 'left' && e.kind === 'launch' && e.abilityId === 'choice-0',
      );
      expect(attack).toBeDefined();
      expect(
        attackLog.some(
          (e) =>
            e.actorId === null &&
            e.kind === 'damage' &&
            e.targetId === 'left' &&
            e.step > attack!.step,
        ),
      ).toBe(true);
      expect(
        attackLog.some(
          (e) =>
            e.kind === 'decision' &&
            e.actorId === 'left' &&
            e.cognition?.kind === 'decision' &&
            e.cognition.selection === 'ability:choice-0' &&
            e.cognition.candidates.some((c) => c.abilityId === 'choice-1'),
        ),
      ).toBe(true);
      for (const record of attacking.records)
        expect(StreamRecordSchema.safeParse(record).success).toBe(true);
    } finally {
      f.world.free();
    }
  });
  it('retains non-water-extinguishable burning and forbids silenced water without inventing immunity', async () => {
    const f = await aiFixture({ steps: 35 });
    try {
      await withInitialStatus(
        f.manifest,
        0,
        initialStatus({
          burning: { waterExtinguishable: false },
          periodic: [{ kind: 'damage', amount: 10, element: 'fire', everySteps: 5 }],
        }),
      );
      const run = await runBattle(f.manifest),
        log = battleEvents(run.records);
      expect(
        log.some((e) => e.actorId === 'left' && e.kind === 'launch' && e.abilityId === 'choice-1'),
      ).toBe(false);
      expect(
        log.filter((e) => e.actorId === null && e.kind === 'damage' && e.targetId === 'left'),
      ).toHaveLength(7);
      const silenced = await aiFixture({ steps: 20 });
      try {
        await withInitialStatus(
          silenced.manifest,
          0,
          initialStatus({
            burning: { waterExtinguishable: true },
            modifiers: {
              attack: 0,
              defense: 0,
              speedBps: 10000,
              flight: false,
              rooted: false,
              silenced: true,
            },
            periodic: [{ kind: 'damage', amount: 10, element: 'fire', everySteps: 5 }],
          }),
        );
        const events = battleEvents((await runBattle(silenced.manifest)).records);
        expect(
          events.some(
            (e) => e.actorId === 'left' && e.kind === 'launch' && e.abilityId === 'choice-0',
          ),
        ).toBe(true);
        expect(
          events.some(
            (e) => e.actorId === 'left' && e.kind === 'launch' && e.abilityId === 'choice-1',
          ),
        ).toBe(false);
      } finally {
        silenced.world.free();
      }
    } finally {
      f.world.free();
    }
  });
  it('executes scoped reveal and experiences, with occlusion and fresh-match knowledge', async () => {
    const input = await catalogManifest('fire-seer', 'ember-duelist', 'flat', 250, 42);
    const run = await runBattle(input),
      events = battleEvents(run.records);
    expect(
      events.some(
        (e) =>
          e.kind === 'knowledge' &&
          e.cognition?.kind === 'knowledge' &&
          e.cognition.learned.some((k) => k.kind === 'reveal' && k.element === 'fire'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.kind === 'knowledge' &&
          e.cognition?.kind === 'knowledge' &&
          e.cognition.learned.some((k) => k.kind === 'impact'),
      ),
    ).toBe(true);
    expect((await runBattle(input)).result).toEqual(run.result);
    await editScenario(input, (scenario) => scenario.obstacles.push(glassWall(5)));
    const blocked = battleEvents((await runBattle(input)).records);
    expect(blocked.some((e) => e.kind === 'knowledge')).toBe(false);
  });
  it('uses four equal flying escapes in actual streamed combat; movement and collisions decide the result', async () => {
    const f = await aiFixture({
      steps: 60,
      character: { body: flyingBody },
      policy: { flightAltitudeMm: 5000 },
      abilities: [
        {
          castSteps: 0,
          recoverySteps: 40,
          attack: {
            kind: 'projectile',
            speedMmPerSecond: 10000,
            radiusMm: 80,
            lifetimeSteps: 200,
            gravityScaleBps: 0,
            homingTurnMilliDegreesPerSecond: 0,
            observation: 'launch-only',
            explosionRadiusMm: 0,
            maxHitsPerTarget: 1,
          },
          effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical' }],
        },
      ],
    });
    try {
      for (const index of [0, 1] as const) {
        f.manifest.participants[index].position.y = 5000;
        await withInitialStatus(
          f.manifest,
          index,
          initialStatus({
            modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: true, rooted: false },
          }),
        );
      }
      const run = await runBattle(f.manifest),
        log = battleEvents(run.records);
      const dodge = log.find(
        (e) =>
          e.actorId === 'left' &&
          e.cognition?.kind === 'decision' &&
          e.cognition.movementSlot?.selection === 'dodge' &&
          e.cognition.directions.every((d) => d.weight === 100),
      );
      expect(dodge).toBeDefined();
      const paths = run.records.flatMap((r) =>
        r.kind === 'interval' && r.fromStep >= dodge!.step
          ? r.paths.filter((p) => p.entityId === 'left').flatMap((p) => p.segments)
          : [],
      );
      expect(paths.some((p) => Math.abs(p.end.y - 5) > 0.1 || Math.abs(p.end.z) > 0.1)).toBe(true);
      expect(run.result.outcome.kind).toBe('draw');
      expect((await runBattle(f.manifest)).result).toEqual(run.result);
    } finally {
      f.world.free();
    }
  });
});
