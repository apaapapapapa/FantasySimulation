import { describe, expect, it } from 'vite-plus/test';
import {
  contentHash,
  DEFAULT_BUDGET,
  ReplayState,
  replayContext,
  type ReplayCheckpoint,
  type StreamRecord,
  type Manifest,
} from '@fantasy/domain/spatial';
import { prepareBattle, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';

const savedManifest = async (...args: Parameters<typeof catalogManifest>) =>
  structuredClone((await prepareBattle(await catalogManifest(...args))).manifest) as Manifest;

describe('engine-independent recorded display restoration', () => {
  it('rejects attributing another actor’s ability to the event actor', async () => {
    const input = await savedManifest('swordsman', 'sky-mage', 'pillars', 10);
    const { result, records } = await runBattle(input);
    const context = await replayContext(input, result.simulationHash);
    const replay = new ReplayState(context);
    for (const record of records) {
      if ('events' in record) {
        const foreign = record.events.find(
          (e) =>
            e.abilityId !== null &&
            context.actors.some(
              (a) =>
                a.participant.actorId !== e.actorId &&
                !a.abilities.some((ability) => ability.id === e.abilityId),
            ),
        );
        if (foreign) {
          const broken = structuredClone(record);
          const event = broken.events.find((e) => e.id === foreign.id)!;
          event.actorId = context.actors.find(
            (a) => a.participant.actorId !== foreign.actorId,
          )!.participant.actorId;
          expect(() => replay.apply(broken)).toThrow(/ability reference/);
          return;
        }
      }
      replay.apply(record);
    }
    throw new Error('Missing asymmetric ability fixture');
  });
  it.each([
    ['swordsman', 'sky-mage', 'pillars'],
    ['archer', 'guardian', 'flat'],
    ['fire-mage', 'ice-mage', 'pillars'],
    ['healer', 'swordsman', 'flat'],
  ])('restores %s / %s continuously and from checkpoints', async (left, right, scenario) => {
    const input = await savedManifest(left, right, scenario, 400),
      { result, records } = await runBattle(input);
    const context = await replayContext(input, result.simulationHash),
      replay = new ReplayState(context);
    const checkpoints: ReplayCheckpoint[] = [];
    for (const [i, record] of records.entries()) {
      if (i % 37 === 0) checkpoints.push(replay.checkpoint());
      replay.apply(record);
    }
    expect(replay.step).toBe(result.steps);
    expect(replay.ended).toBe(true);
    for (const checkpoint of checkpoints.reverse()) {
      const seek = new ReplayState(context, checkpoint);
      for (const record of records.slice(checkpoint.nextRecord)) seek.apply(record);
      expect(seek.checkpoint()).toEqual(replay.checkpoint());
    }
    expect(() => replay.apply(records[0])).toThrow(/terminal/);
  });
  it('retains only verified records on invalid order, references and trajectories', async () => {
    const input = await savedManifest('swordsman', 'sky-mage', 'pillars', 10),
      { result, records } = await runBattle(input);
    const context = await replayContext(input, result.simulationHash);
    const intervalIndex = records.findIndex((r) => r.kind === 'interval');
    const replay = new ReplayState(context);
    records.slice(0, intervalIndex).forEach((r) => replay.apply(r));
    const before = replay.checkpoint(),
      interval = records[intervalIndex] as Extract<StreamRecord, { kind: 'interval' }>;
    for (const mutate of [
      (r: typeof interval) => {
        r.fromStep++;
        r.toStep++;
      },
      (r: typeof interval) => {
        r.paths[0]!.segments[0]!.start.x += 1;
      },
      (r: typeof interval) => {
        r.paths.pop();
      },
      (r: typeof interval) => {
        r.changes.push({ id: 'unknown' });
      },
    ]) {
      const broken = structuredClone(interval);
      mutate(broken);
      expect(() => replay.apply(broken)).toThrow();
      expect(replay.checkpoint()).toEqual(before);
    }
    replay.apply(interval);
  });
  it('supports complete initial-only budget failures without fabricating a decision', async () => {
    const input = await savedManifest('swordsman', 'sky-mage', 'pillars', 10);
    const { result, records } = await runBattle(input, { ...DEFAULT_BUDGET, maxBytes: 1 });
    expect(result.outcome.kind).toBe('truncated');
    const replay = new ReplayState(await replayContext(input, result.simulationHash));
    records.forEach((r) => replay.apply(r));
    expect(replay.checkpoint().lastRecord).toEqual(records.at(-1));
  });
  it('reads recorded engine versions without accepting them for execution', async () => {
    const input = await savedManifest('swordsman', 'sky-mage', 'pillars', 1);
    const original = await replayContext(input, await contentHash(input));
    const old = structuredClone(input) as unknown as Record<string, unknown>;
    old.engineVersion = 'spatial-v0.saved';
    old.implementationDigest = `sha256:${'1'.repeat(64)}`;
    const revisions = structuredClone(input.revisions),
      rules = revisions.find((r) => r.kind === 'ruleset')!;
    Object.assign(rules.definition, { rulesVersion: 'spatial-v0.saved' });
    rules.contentHash = await contentHash({
      kind: rules.kind,
      schemaVersion: rules.schemaVersion,
      definition: rules.definition,
    });
    old.ruleset = { id: rules.id, revision: rules.revision, contentHash: rules.contentHash };
    old.revisions = revisions;
    expect((await replayContext(old, await contentHash(old))).actors).toEqual(original.actors);
    await expect(runBattle(old)).rejects.toThrow();
    await expect(replayContext({ ...old, seed: 2 }, await contentHash(old))).rejects.toThrow(
      /simulation hash/,
    );
  });
});
