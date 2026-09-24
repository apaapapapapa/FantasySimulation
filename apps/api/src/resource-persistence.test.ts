import { describe, expect, it } from 'vite-plus/test';
import { ReplayState, replayContext } from '@fantasy/domain/spatial';
import { prepareBattle, reference, sealRevision } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import priorStamina from '../fixtures/compatibility/stamina-v1.11.json' with { type: 'json' };
import { specInput, withRuntime } from '../test-support/runtime.ts';
import { seekReplay, verifyReplay } from './replay-reader.ts';

describe('stamina through Worker, SQLite and recorded replay', () => {
  it('reads published stamina-only v1.11 displays unchanged and refuses execution under current rules', async () => {
    const replay = new ReplayState(
      await replayContext(priorStamina.input, priorStamina.result.simulationHash),
    );
    for (const record of priorStamina.records) replay.apply(record);
    const actors = replay.checkpoint().state!.actors;
    expect(actors.map((actor) => actor.resources.stamina)).toEqual([0, 0]);
    expect(actors.every((actor) => actor.locomotion === undefined)).toBe(true);
    expect(actors[0]!.position.x).toBeGreaterThan(-4);
    await expect(prepareBattle(priorStamina.input)).rejects.toThrow(/Unsupported engine version/);
  });
  it('saves new locomotion and paid-flight definitions and reconstructs resource and grant displays', async () => {
    await withRuntime(
      async ({ runtime, store, root }) => {
        const input = await catalogManifest(
          'stamina-glider-v1',
          'stamina-scout-v1',
          'flat-surveyed-v1',
          100,
        );
        await store.seedRevisions(input.revisions);
        const job = await runtime.submit(specInput(input), 'locomotion', 'persist');
        const done = await runtime.wait(job.id);
        expect(done.state).toBe('completed');
        const saved = store.getSpec(done.simulationHash)!;
        const character = saved.manifest.revisions.find(
          (r) => r.kind === 'character' && r.id === 'stamina-glider-v1',
        );
        expect(character?.definition).toHaveProperty(
          'movement.locomotion.run.speedMmPerSecond',
          6000,
        );
        const result = runtime.jobs.result(done.resultId!)!;
        const verified = await verifyReplay(root, result.replayId);
        const restored = await seekReplay(root, result.replayId, verified.checkpoint.nextRecord);
        expect(restored).toEqual(verified.checkpoint);
        const flyer = restored.state!.actors.find((a) => a.id === 'left')!;
        expect(flyer.resources.stamina).toBeLessThan(95);
        expect(flyer.statuses[0]?.flightStaminaPerSecond).toBe(5);
        expect(flyer.locomotion).toEqual({ mode: 'flight', jumping: false, dodging: false });
        expect(flyer.position.y).toBeGreaterThan(1);
      },
      {},
      100,
    );
  });
  it('persists optional definitions and restores charged/recovered resources from verified artifacts', async () => {
    await withRuntime(async ({ runtime, store, root, manifest, spec }) => {
      const base = manifest.revisions.find((r) => r.kind === 'ability')!;
      const startup = await sealRevision('ability', 'resource-startup', 1, {
        ...base.definition,
        trigger: 'battle-start',
        target: 'self',
        attack: { kind: 'direct' },
        castSteps: 0,
        condition: { kind: 'always' },
        costs: { hp: 0, mp: 0, stamina: 8, uses: 1 },
        effects: [{ kind: 'shield', amount: 1 }],
      });
      const old = manifest.revisions.find(
        (r) => r.kind === 'character' && r.id === spec.participants[0].character.id,
      )!;
      if (old.kind !== 'character') throw Error('Missing fixture character');
      const character = await sealRevision('character', 'resource-archer', 1, {
        ...old.definition,
        stamina: { max: 10, recoveryPerSecond: 3 },
        abilities: [...old.definition.abilities, reference(startup)],
      });
      await store.seedRevisions([startup, character]);
      spec.participants[0].character = reference(character);
      const submitted = await runtime.submit(spec, 'resources', 'persist');
      const done = await runtime.wait(submitted.id);
      expect(done.state).toBe('completed');
      const saved = store.getSpec(done.simulationHash)!;
      expect(
        saved.manifest.revisions.find((r) => r.id === character.id)?.definition,
      ).toHaveProperty('stamina', { max: 10, recoveryPerSecond: 3 });
      const result = runtime.jobs.result(done.resultId!)!;
      const verified = await verifyReplay(root, result.replayId);
      const restored = await seekReplay(root, result.replayId, verified.checkpoint.nextRecord);
      expect(restored).toEqual(verified.checkpoint);
      const actors = restored.state!.actors;
      expect(actors.find((a) => a.id === spec.participants[0].actorId)?.resources.stamina).toBe(5);
      expect(
        actors.find((a) => a.id === spec.participants[1].actorId)?.resources,
      ).not.toHaveProperty('stamina');
    });
  });
});
