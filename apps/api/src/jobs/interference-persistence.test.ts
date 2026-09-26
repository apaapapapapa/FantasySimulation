import { expect, it } from 'vite-plus/test';
import {
  ResultSchema,
  ManifestSchema,
  DEFAULT_BUDGET,
  canonicalJson,
  contentHash,
} from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { statusConflictManifest } from '../../../../packages/engine/test-support/interference-diagnostics.ts';
import { specInput, withRuntime } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';
import { experimentalRules } from '@fantasy/samples/testing';
import { withJobs } from '../../test-support/jobs.ts';
import { battleSpecs, simulationJobs } from '../db/schema.ts';

it('rejects forbidden mechanics before submission retry reservations and Worker allocation', async () => {
  await withRuntime(async ({ runtime, store, jobs, manifest }) => {
    const input = await experimentalRules(manifest, ['foresight']);
    await store.seedRevisions(input.revisions);
    await expect(runtime.submit(specInput(input), 'denied', 'one')).rejects.toMatchObject({
      code: 'unsupported-mechanic',
      mechanic: 'foresight',
    });
    expect(jobs.request('denied', 'one')).toBeUndefined();
    expect(store.orm.select().from(battleSpecs).all()).toEqual([]);
    expect(store.orm.select().from(simulationJobs).all()).toEqual([]);
  });
  await withJobs(async ({ store, jobs, battle, submit }) => {
    const denied = await experimentalRules(ManifestSchema.parse(battle.manifest), ['foresight']);
    const hash = await contentHash(denied);
    // A readable saved input from another admission policy must not become executable on retry.
    store.orm
      .insert(battleSpecs)
      .values({
        simulationHash: hash,
        manifestJson: canonicalJson(denied),
        createdAt: '2026-09-26T00:00:00.000Z',
      })
      .run();
    const old = jobs.cancel(submit('template').id, 101);
    const saved = {
      ...old,
      id: 'historical-experimental',
      simulationHash: hash,
      idempotencyKey: 'historical',
    };
    store.orm.insert(simulationJobs).values(saved).run();
    expect(() =>
      jobs.submit({
        simulationHash: hash,
        clientId: 'new',
        key: 'new',
        requestHash: hash,
        budget: DEFAULT_BUDGET,
      }),
    ).toThrow('Reserved mechanic');
    expect(() => jobs.retry(saved.id, 0, DEFAULT_BUDGET, 102)).toThrow('Reserved mechanic');
    expect(jobs.get(saved.id)).toEqual(saved);
    expect(
      store.orm
        .select()
        .from(simulationJobs)
        .all()
        .every((j) => j.state === 'cancelled'),
    ).toBe(true);
    expect(jobs.attempts(saved.id)).toEqual([]);
  });
});

it('round-trips structured interference through a real Worker SQLite result and engine-free replay seek', async () => {
  await withRuntime(async ({ runtime, jobs, store, root }) => {
    const input = await statusConflictManifest('status.reaction-conflict');
    await store.seedRevisions(input.revisions);
    const direct = await runBattle((await store.prepareSpec(specInput(input))).manifest);
    const submitted = await runtime.submit(specInput(input), 'interference', 'persist');
    const done = await runtime.wait(submitted.id);
    expect(done.state).toBe('completed');
    const result = jobs.result(done.resultId!)!;
    const saved = ResultSchema.parse(JSON.parse(result.resultJson));
    expect(saved).toEqual(direct.result);
    expect(saved.outcome).toMatchObject({
      kind: 'unresolved',
      interferences: [{ step: 5, point: 'status-commit', causes: expect.any(Array) }],
    });
    const verified = await verifyReplay(root, result.replayId);
    const end = await seekReplay(root, result.replayId, verified.checkpoint.nextRecord);
    expect(end).toEqual(verified.checkpoint);
    expect(end.lastRecord).toMatchObject({ kind: 'terminal', outcome: saved.outcome });
    const beginning = await seekReplay(root, result.replayId, 1);
    expect(beginning.state!.actors.every((a) => a.statuses.length === 0)).toBe(true);
    expect(
      (await seekReplay(root, result.replayId, verified.checkpoint.nextRecord)).lastRecord,
    ).toEqual(end.lastRecord);
  });
});
