import { describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { StreamRecordSchema } from '@fantasy/domain/spatial';
import { reference, sealRevision, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { withRuntime, specInput } from '../test-support/runtime.ts';
import { withReplayDirectory } from '../test-support/replays.ts';
import { batchInput, batchSource } from '../test-support/batches.ts';
import { createApp } from './app.ts';
import { readReplayChunk, seekReplay, verifyReplay } from './replay-reader.ts';
import { createBatchPlan } from './batch-plan.ts';
import { runBatch, reconcileBatch } from './batch-runner.ts';
import { BattleBundles } from './battle-bundle.ts';

/** The API, persistence and headless paths must all execute the same prepared engine inputs. */
describe('observed AI delivery through persisted Workers', () => {
  it('persists tactical samples through API and reproduces posture and search records headlessly', async () => {
    await withRuntime(
      async ({ runtime, store, root }) => {
        const input = await catalogManifest(
          'posture-archer-v1',
          'posture-duelist-v1',
          'cover-surveyed-v1',
          700,
          42,
          'standard-tactics-v1',
        );
        await store.loadPinnedRevisions(input.revisions);
        const app = createApp(store, false, runtime);
        try {
          const response = await app.inject({
            method: 'POST',
            url: '/api/battle-jobs',
            headers: { 'x-client-id': 'tactical-ai', 'idempotency-key': 'one' },
            payload: { spec: specInput(input) },
          });
          expect(response.statusCode).toBe(202);
          const done = await runtime.wait(response.json().job.id);
          expect(done.state, JSON.stringify(done)).toBe('completed');
          const row = runtime.jobs.result(done.resultId!)!;
          const saved = (await verifyReplay(root, row.replayId)).manifest;
          const direct = await runBattle(saved.input);
          expect(JSON.parse(row.resultJson)).toEqual(direct.result);
          for (const record of direct.records)
            expect(StreamRecordSchema.safeParse(record).success).toBe(true);
          const cognition = direct.records
            .flatMap((r) => ('events' in r ? r.events : []))
            .flatMap((e) => (e.cognition?.kind === 'decision' ? [e.cognition] : []));
          expect(cognition.some((c) => c.search)).toBe(true);
          expect(cognition.some((c) => c.cover?.draw.selection !== 'ordinary' && c.cover)).toBe(
            true,
          );
          const actors = direct.records.flatMap((r) => ('changes' in r ? r.changes : []));
          expect(
            actors.some(
              (a) => a.posture?.current === 'crouching' || a.posture?.current === 'prone',
            ),
          ).toBe(true);
        } finally {
          await app.close();
        }
      },
      { workers: 1 },
      700,
    );
  }, 30000);
  it('round trips public status experience, observed conditions and weighted reasons through SQLite and replay', async () => {
    await withRuntime(
      async ({ runtime, store, root }) => {
        const manifest = await catalogManifest('water-observer', 'ember-duelist', 'flat', 60, 4);
        const burn = manifest.revisions.find(
          (r) => r.kind === 'status' && r.id === 'ordinary-burning',
        )!;
        if (burn.kind !== 'status') throw Error('Missing status');
        const status = await sealRevision('status', 'g05-visible', 1, {
          ...burn.definition,
          durationSteps: 40,
          periodic: [],
          visibility: 'visible',
          adjustments: [
            { target: 'action', operation: 'multiply', amount: 0 },
            { target: 'damageTaken', operation: 'multiply', amount: 20000 },
          ],
        });
        const probe = manifest.revisions.find(
          (r) => r.kind === 'ability' && r.id === 'measured-fire',
        )!;
        if (probe.kind !== 'ability') throw Error('Missing probe');
        const fire = await sealRevision('ability', 'g05-fire', 1, {
          ...probe.definition,
          condition: { kind: 'observed-phase', phase: 'idle' },
        });
        const grant = await sealRevision('ability', 'g05-grant', 1, {
          ...probe.definition,
          trigger: 'battle-start',
          target: 'self',
          attack: { kind: 'direct' },
          condition: { kind: 'always' },
          costs: { hp: 0, mp: 0, uses: 1 },
          castSteps: 0,
          effects: [{ kind: 'apply-status', status: reference(status) }],
        });
        const additions = [status, fire, grant];
        for (const [i, participant] of manifest.participants.entries()) {
          const old = manifest.revisions.find(
            (r) => r.kind === 'character' && r.id === participant.character.id,
          )!;
          if (old.kind !== 'character') throw Error('Missing actor');
          const policy = manifest.revisions.find(
            (r) => r.kind === 'policy' && r.id === old.definition.policy.id,
          )!;
          if (policy.kind !== 'policy') throw Error('Missing policy');
          const nextPolicy = await sealRevision('policy', `g05-policy-${i}`, 1, {
            ...policy.definition,
            priorities: policy.definition.priorities.map((p) => ({
              ...p,
              abilityId: i === 0 && p.abilityId === probe.id ? fire.id : p.abilityId,
            })),
          });
          const actor = await sealRevision('character', `g05-actor-${i}`, 1, {
            ...old.definition,
            policy: reference(nextPolicy),
            abilities:
              i === 0
                ? old.definition.abilities.map((a) => (a.id === probe.id ? reference(fire) : a))
                : [...old.definition.abilities, reference(grant)],
          });
          manifest.revisions.push(nextPolicy, actor);
          participant.character = reference(actor);
        }
        manifest.revisions.push(...additions);
        await store.seedRevisions(manifest.revisions);
        const job = await runtime.submit(specInput(manifest), 'g05', 'public-context');
        const done = await runtime.wait(job.id);
        expect(done.state).toBe('completed');
        const row = runtime.jobs.result(done.resultId!)!;
        const verified = await verifyReplay(root, row.replayId),
          saved = verified.manifest;
        expect(JSON.parse(row.resultJson)).toEqual((await runBattle(saved.input)).result);
        expect(saved.input.revisions.find((r) => r.kind === 'ruleset')?.definition).toHaveProperty(
          'ai.appearancePriors.cues',
        );
        const records = [];
        for (let i = 0; i < saved.chunks.length; i++)
          records.push(
            ...(await readReplayChunk(join(root, saved.id), saved, i)).map((r) =>
              StreamRecordSchema.parse(r),
            ),
          );
        const cognition = records
          .flatMap((r) => ('events' in r ? r.events : []))
          .flatMap((e) => (e.cognition ? [e.cognition] : []));
        expect(
          cognition.some(
            (c) =>
              c.kind === 'knowledge' &&
              c.learned.some((e) => e.observedStatuses?.some((s) => s.id === status.id)),
          ),
        ).toBe(true);
        expect(
          cognition.some((c) => c.kind === 'decision' && c.conditionObservation?.phase === 'idle'),
        ).toBe(true);
        const decisions = cognition.flatMap((c) =>
          c.kind === 'decision' && c.candidates.length > 1 ? [c] : [],
        );
        expect(decisions.length).toBeGreaterThan(0);
        for (const decision of decisions) {
          const total = decision.candidates.reduce((n, c) => n + c.weight, 0);
          expect(
            decision.candidates.every((c) => c.totalWeight === total && c.reason.length > 0),
          ).toBe(true);
        }
        expect((await seekReplay(root, saved.id, 1)).nextRecord).toBe(1);
        expect(await seekReplay(root, saved.id, saved.records)).toEqual(verified.checkpoint);
      },
      {},
      60,
    );
  });

  it('prepares new typed characters through API, saves cognition, and isolates reused Worker knowledge', async () => {
    await withRuntime(
      async ({ runtime, store, root }) => {
        const manifest = await catalogManifest('fire-seer', 'ember-duelist', 'flat', 250, 42);
        await store.loadPinnedRevisions(manifest.revisions);
        const spec = specInput(manifest),
          app = createApp(store, false, runtime);
        try {
          const response = await app.inject({
            method: 'POST',
            url: '/api/battle-jobs',
            headers: { 'x-client-id': 'observed-ai', 'idempotency-key': 'one' },
            payload: { spec },
          });
          expect(response.statusCode).toBe(202);
          const done = await runtime.wait(response.json().job.id);
          expect(done.state).toBe('completed');
          const row = runtime.jobs.result(done.resultId!)!,
            saved = await runtime.artifacts.verified(row.replayId);
          expect(saved.input.aiProfile).toBe('observed-utility-v1');
          const records = [];
          for (let i = 0; i < saved.chunks.length; i++)
            for (const record of await readReplayChunk(join(root, saved.id), saved, i))
              records.push(StreamRecordSchema.parse(record));
          const cognition = records
            .flatMap((r) => ('events' in r ? r.events : []))
            .flatMap((e) => (e.cognition ? [e.cognition] : []));
          expect(
            cognition.some(
              (c) => c.kind === 'knowledge' && c.learned.some((k) => k.kind === 'reveal'),
            ),
          ).toBe(true);
          expect(cognition.some((c) => c.kind === 'decision' && c.candidates.length > 1)).toBe(
            true,
          );
          const next = await catalogManifest('water-observer', 'ember-duelist', 'flat', 250, 7);
          await store.loadPinnedRevisions(next.revisions);
          const job = await runtime.submit(specInput(next), 'isolation', 'two');
          const finished = await runtime.wait(job.id);
          expect(finished.state).toBe('completed');
          const actual = runtime.jobs.result(finished.resultId!)!;
          expect(JSON.parse(actual.resultJson)).toEqual((await runBattle(next)).result);
        } finally {
          await app.close();
        }
      },
      { workers: 1 },
      250,
    );
  }, 20000);
  it('runs, verifies and reuses new AI characters in the ordinary headless plan', async () => {
    await withReplayDirectory(async (root) => {
      const manifest = await catalogManifest('water-observer', 'ember-duelist', 'flat', 30, 42),
        base = await batchInput(1);
      const plan = await createBatchPlan(
        {
          ...base,
          revisions: manifest.revisions,
          matches: [{ key: 'observed-ai', spec: specInput(manifest) }],
        },
        batchSource,
      );
      const first = await runBatch(plan, root, batchSource);
      expect(first.index.complete).toBe(true);
      const again = await runBatch(plan, root, batchSource);
      expect(again.index.slots[0]!.reused).toBe(true);
      expect(
        (await reconcileBatch(plan, [{ index: first.index, bundles: new BattleBundles(root) }]))
          .complete,
      ).toBe(true);
    });
  }, 20000);
});
