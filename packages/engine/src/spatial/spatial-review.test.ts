import { beforeAll, expect, it } from 'vite-plus/test';
import { ReplayState } from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { aiFixture } from '../../test-support/ai.ts';
import { objectAbility, objectManifest } from '../../test-support/object-manifest.ts';
import { relocationManifest } from '../../test-support/spatial-objects.ts';
import { phasingManifest } from '../../test-support/phasing.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { initializePhysics, SpatialWorld } from './world/physics.ts';
import { emptyMemory, perceive } from './ai/perception.ts';
import { observeSpatial, spatialEscape } from './ai/spatial-observation.ts';
import type { SpatialObject } from './rules/spatial-objects.ts';
import { runBattle } from './run.ts';

beforeAll(initializePhysics);
it('delivers visible spatial samples late while keeping hidden geometry and object state private', async () => {
  const f = await aiFixture({
    abilities: [objectAbility('barrier')],
    policy: { movement: 'approach' },
  });
  const ability = f.self.actor.abilities[0]!;
  const object: SpatialObject = {
    kind: 'barrier',
    id: 'object.sensor',
    ownerId: 'right',
    ownerSlot: 1,
    ordinal: 0,
    ability,
    actionId: 'action.sensor',
    cause: 'e.0',
    launchStep: 0,
    activeFrom: 1,
    endStep: 4,
    active: true,
    position: { x: 0, y: 1, z: 0 },
    attack: 0,
    spec: ability.definition.barrier!,
    durability: 7,
    offset: { x: 0, y: 0, z: 0 },
  };
  const hidden = new SpatialWorld([
    {
      id: 'cover',
      position: { x: -2, y: 2, z: 0 },
      halfExtents: { x: 0.1, y: 3, z: 10 },
      blocks: { movement: true, vision: true, attack: true },
    },
  ]);
  try {
    const sampled = perceive(
      f.world,
      f.self,
      f.enemy,
      [],
      0,
      emptyMemory(),
      undefined,
      'surveyed',
      f.view.rules,
      undefined,
      [object],
    );
    expect(sampled.observation).toBeNull();
    expect(sampled.pending[0]!.spatial).toHaveLength(1);
    const sample = sampled.pending[0]!.spatial![0]!;
    expect(Object.keys(sample).sort()).toEqual(['id', 'kind', 'ownerId', 'pointsMm']);
    expect(observeSpatial(f.world, f.self, [{ ...object, durability: 1, endStep: 6000 }])).toEqual([
      sample,
    ]);
    const delivered = perceive(
      f.world,
      f.self,
      f.enemy,
      [],
      5,
      sampled,
      undefined,
      'surveyed',
      f.view.rules,
      undefined,
      [],
    );
    expect(delivered.observation?.spatial).toEqual([sample]);
    const unseen = perceive(
      hidden,
      f.self,
      f.enemy,
      [],
      0,
      emptyMemory(),
      undefined,
      'surveyed',
      f.view.rules,
      undefined,
      [object],
    );
    const absent = perceive(
      hidden,
      f.self,
      f.enemy,
      [],
      0,
      emptyMemory(),
      undefined,
      'surveyed',
      f.view.rules,
      undefined,
      [],
    );
    expect(unseen).toEqual(absent);
    const view = {
      ...f.view,
      memory: {
        ...delivered,
        observation: {
          ...delivered.observation!,
          spatial: [
            {
              ...sample,
              kind: 'area' as const,
              pointsMm: [
                {
                  x: Math.round(f.self.position.x * 1000) + 500,
                  y: Math.round(f.self.position.y * 1000),
                  z: Math.round(f.self.position.z * 1000),
                },
              ],
            },
          ],
        },
      },
    };
    expect(spatialEscape(view, null)!.x).toBeLessThan(f.self.position.x);
    expect(
      spatialEscape({ ...view, memory: { ...view.memory, observation: null } }, null),
    ).toBeNull();
  } finally {
    hidden.free();
    f.world.free();
  }
});

it('preserves all result digests under participant and revision input enumeration for every new spatial operation', async () => {
  for (const input of [
    await relocationManifest(),
    ...(await Promise.all(
      (['barrier', 'area', 'beam'] as const).map((kind) => objectManifest(kind)),
    )),
    await phasingManifest(),
  ]) {
    const first = await runBattle(input);
    const changed = {
      ...input,
      revisions: [...input.revisions].reverse(),
      participants: [...input.participants].reverse(),
    };
    const second = await runBattle(changed);
    const { simulationHash: _a, ...expected } = first.result,
      { simulationHash: _b, ...actual } = second.result;
    expect(actual).toEqual(expected);
  }
});

it.each(['barrier', 'beam'] as const)(
  'rejects forged %s checkpoint geometry and source without mutating replay',
  async (kind) => {
    const input = await objectManifest(kind),
      run = await runBattle(input),
      saved = await recordedCheckpoints(input, run);
    const checkpoint = saved.checkpoints.find((c) =>
      c.state?.objects?.some((o) => o.kind === kind),
    )!;
    const original = new ReplayState(saved.context, checkpoint).checkpoint();
    for (const mutation of ['bounds', 'cause', 'shape'] as const) {
      const bad = structuredClone(checkpoint),
        object = bad.state!.objects![0]!;
      if (mutation === 'cause') object.cause = 'e.999999';
      else if (mutation === 'bounds') object.position.x = 50;
      else if (kind === 'barrier') object.durability = object.maxDurability! + 1;
      else if (object.geometry?.kind === 'ray') object.geometry.segments[0]!.end.z += 0.25;
      expect(() => new ReplayState(saved.context, bad), mutation).toThrow();
      expect(new ReplayState(saved.context, checkpoint).checkpoint()).toEqual(original);
    }
  },
);

it('executes the new phasing samples and material arena with preserved recorded provenance', async () => {
  const input = await catalogManifest(
      'phase-traveller-v1',
      'phase-archer-v1',
      'phase-stone-corridor-v1',
      180,
    ),
    run = await runBattle(input);
  expect(['win', 'draw']).toContain(run.result.outcome.kind);
  expect(battleEvents(run.records).some((e) => e.ruleId === 'phasing.boundary')).toBe(true);
  expect(run.records.some((r) => r.kind === 'interval' && r.projectiles.spawn.length)).toBe(true);
  await recordedCheckpoints(input, run);
});
