import assert from 'node:assert/strict';
import { describe, expect, it } from 'vite-plus/test';
import fc from 'fast-check';
import {
  actorSeed,
  contentHash,
  type Definition,
} from '../../packages/domain/src/spatial/index.ts';
import {
  prepareBattle,
  sampleManifest,
  runBattle,
  sealRevision,
  reference,
} from '../../packages/engine/src/spatial/index.ts';
import {
  resolveEffects,
  type EffectApplication,
} from '../../packages/engine/src/spatial/effects.ts';
import { applyStatuses, statusBoundary } from '../../packages/engine/src/spatial/status.ts';
import { combatManifest, battleEvents } from '../../packages/engine/test-support/fixtures.ts';
import { checkProperty } from './test-support/property.ts';
import minimized from './fixtures/minimized-hp.json' with { type: 'json' };

const file = 'scripts/harness/properties.test.ts';
describe('bounded generated battle invariants', { timeout: 45000 }, () => {
  it('checks HP MP resistance and shared shield boundaries against integer arithmetic', async () => {
    const battle = await prepareBattle(await sampleManifest(1));
    await checkProperty(
      'resource-boundaries',
      file,
      fc.asyncProperty(
        fc.record({
          hp: fc.integer({ min: 0, max: 100 }),
          mp: fc.integer({ min: 0, max: 100 }),
          damage: fc.integer({ min: 0, max: 200 }),
          shield: fc.integer({ min: 0, max: 200 }),
          resistance: fc.integer({ min: 0, max: 10000 }),
        }),
        async ({ hp, mp, damage, shield, resistance }) => {
          const base = battle.actors[0]!;
          const actor = {
            ...base,
            character: {
              ...base.character,
              stats: {
                ...base.character.stats,
                resistances: { ...base.character.stats.resistances, physical: resistance },
              },
            },
          };
          const targets = [{ actor, resources: { hp, mp, shield }, statuses: [] }];
          const applications: EffectApplication[] = ['a', 'b'].map((id) => ({
            id,
            actorId: 'right',
            targetId: 'left',
            attack: 0,
            effect: { kind: 'damage', amount: damage, attackScaleBps: 0, element: 'physical' },
          }));
          const expectedDamage =
            2 * Math.floor((Math.max(0, damage - 5) * (10000 - resistance)) / 10000);
          const actual = resolveEffects(targets, applications, [], 0);
          assert.deepEqual(actual[0]!.resources, {
            hp: Math.max(0, hp - Math.max(0, expectedDamage - shield)),
            mp,
            shield: Math.max(0, shield - expectedDamage),
          });
          assert.deepEqual(resolveEffects(targets, [...applications].reverse(), [], 0), actual);
          assert.equal(targets[0]!.resources.hp, hp);
        },
      ),
      {},
      { manifestHash: await contentHash(battle.manifest), battleSeed: battle.manifest.seed },
    );
  });

  it('generates status lifetimes with expiry before periodic damage', async () => {
    await checkProperty(
      'status-boundaries',
      file,
      fc.asyncProperty(
        fc.record({
          start: fc.integer({ min: 0, max: 20 }),
          duration: fc.integer({ min: 1, max: 20 }),
          period: fc.integer({ min: 1, max: 5 }),
        }),
        async ({ start, duration, period }) => {
          const definition: Definition<'status'> = {
            name: 'bounded',
            originalText: '',
            stackKey: 'bounded',
            stacking: 'refresh',
            durationSteps: duration,
            maxStacks: 1,
            modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: false, rooted: false },
            periodic: [{ kind: 'damage', element: 'fire', amount: 1, everySteps: period }],
          };
          const revision = await sealRevision('status', 'bounded', 1, definition);
          const statuses = applyStatuses([], [{ revision, cause: 'source' }], [], start).statuses;
          const pulses: number[] = [];
          for (let step = 0; step <= start + duration; step++)
            if (statusBoundary(statuses, step).pulses.length) pulses.push(step);
          assert.deepEqual(
            pulses,
            Array.from({ length: Math.ceil(duration / period) }, (_, i) => start + i * period),
          );
          assert.equal(statusBoundary(statuses, start + duration).removed.length, 1);
        },
      ),
    );
  });

  it('exchanges actor IDs slots positions facings and owned random streams independently of hash equality', async () => {
    const manifest = await combatManifest(1000, {
      ability: {
        attack: { kind: 'hitscan', radiusMm: 100 },
        rangeMm: 20000,
        castSteps: 0,
        aimErrorMilliDegrees: 5000,
      },
      policy: { movement: 'hold' },
    });
    const original = manifest.revisions.find((r) => r.kind === 'character')!;
    const weaker = await sealRevision('character', 'weaker', 1, {
      ...original.definition,
      stats: { ...original.definition.stats, hp: 50 },
    });
    manifest.revisions.push(weaker);
    manifest.participants[1]!.character = reference(weaker);
    const first = await runBattle(manifest);
    assert.deepEqual(first.result.outcome, { kind: 'win', winner: 'left' });
    const changed = structuredClone(manifest);
    const exchange = (id: string | null) =>
      id === 'left' ? 'right' : id === 'right' ? 'left' : id;
    for (const actor of changed.participants) {
      actor.actorId = exchange(actor.actorId)!;
      actor.position.x *= -1;
      actor.position.z *= -1;
      actor.facing.x *= -1;
      actor.facing.z *= -1;
      // rngStream/rngSeed travel with the actor; no new random stream is derived from its slot.
    }
    changed.participants.reverse();
    const swapped = await runBattle(changed);
    assert.notEqual(swapped.result.simulationHash, first.result.simulationHash);
    assert.deepEqual(swapped.result.outcome, { kind: 'win', winner: 'right' });
    assert.equal(swapped.result.steps, first.result.steps);
    const damage = (run: typeof first, remap: boolean) =>
      battleEvents(run.records)
        .filter((event) => event.kind === 'damage')
        .map((event) => ({
          step: event.step,
          actor: remap ? exchange(event.actorId) : event.actorId,
          target: remap ? exchange(event.targetId) : event.targetId,
          amount: event.amount,
          after: event.after,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(damage(swapped, true), damage(first, false));
    const wrong = structuredClone(changed);
    wrong.participants.forEach((actor, index) => {
      actor.rngStream = index as 0 | 1;
      actor.rngSeed = actorSeed(wrong.seed, actor.rngStream);
    });
    const misassigned = await runBattle(wrong);
    assert.notDeepEqual(
      damage(misassigned, true),
      damage(first, false),
      'Slot-owned streams must change observed random-dependent attacks',
    );
    await checkProperty(
      'fixed-battle-enumeration',
      file,
      fc.asyncProperty(
        fc.record({
          reverse: fc.boolean(),
          battleSeed: fc.constant(manifest.seed),
          inputHash: fc.constant(await contentHash(manifest)),
        }),
        async ({ reverse }) => {
          const input = structuredClone(manifest);
          if (reverse) input.revisions.reverse();
          const next = await runBattle(input);
          assert.equal(next.result.eventHash, first.result.eventHash);
          assert.equal(next.result.physicsStateHash, first.result.physicsStateHash);
        },
      ),
      { numRuns: 4 },
      { manifestHash: await contentHash(manifest), battleSeed: manifest.seed },
    );
  });

  it('retains a minimized counterexample for an intentional assertion violation and succeeds after correction', async () => {
    const battle = await prepareBattle(await sampleManifest(1));
    const property = (broken: boolean) =>
      fc.asyncProperty(fc.integer({ min: 0, max: 20 }), async (damage) => {
        const resolved = resolveEffects(
          [{ actor: battle.actors[0]!, resources: { hp: 0, mp: 0, shield: 0 }, statuses: [] }],
          [
            {
              id: 'hit',
              actorId: 'right',
              targetId: 'left',
              attack: 0,
              effect: { kind: 'damage', amount: damage, attackScaleBps: 0, element: 'physical' },
            },
          ],
          [],
          0,
        );
        if (broken) resolved[0]!.resources.hp -= damage; // Deliberate corruption of the real resolver output.
        assert.ok(resolved[0]!.resources.hp >= 0, 'HP must never be negative');
      });
    const context = {
      manifestHash: await contentHash(battle.manifest),
      battleSeed: battle.manifest.seed,
    };
    await expect(
      checkProperty('negative-hp-mutant', file, property(true), {}, context),
    ).rejects.toThrow('HP must never be negative');
    await checkProperty(
      'negative-hp-corrected',
      file,
      property(false),
      {
        examples: [[minimized.input]],
      },
      context,
    );
  });
});
