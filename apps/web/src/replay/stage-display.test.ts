import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamRecordSchema, type ActorDelta, type ReplayManifest } from '@fantasy/domain/spatial';
import { openReplay, type OpenedReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { readLocalFiles, localReplaySource } from './local-source.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { ReplayResources } from './ReplayResources.tsx';

// #61 elements recorded by the real writer (stamina, walk/run, staged dash/sweep, force).
const FIXTURE = new URL(
  '../../test-fixtures/replays/stage-vanguard-staged-duelist-300/',
  import.meta.url,
);
let opened: OpenedReplay;
let deltas: { step: number; change: ActorDelta }[];
beforeAll(async () => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const name of await readdir(FIXTURE))
    files.set(name, new Uint8Array(await readFile(new URL(name, FIXTURE))));
  opened = await openReplay(
    localReplaySource(
      await readLocalFiles(
        [...files].map(([name, bytes]) => ({
          name,
          size: bytes.length,
          arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
        })),
      ),
    ),
  );
  const manifest = JSON.parse(
    Buffer.from(files.get('manifest.json')!).toString(),
  ) as ReplayManifest;
  // Expected values come from the raw saved deltas, not from the projection under test.
  deltas = manifest.chunks.flatMap((chunk) =>
    gunzipSync(files.get(chunk.file)!)
      .toString()
      .trimEnd()
      .split('\n')
      .flatMap((line) => {
        const record = StreamRecordSchema.parse(JSON.parse(line));
        return record.kind === 'interval' || record.kind === 'boundary'
          ? record.changes.map((change) => ({
              step: record.kind === 'interval' ? record.toStep : record.step,
              change,
            }))
          : [];
      }),
  );
});
const first = (match: (change: ActorDelta) => boolean) => deltas.find((d) => match(d.change))!;
async function view(step: number) {
  const frame = await new ReplayPlayer(opened).frame(step);
  const model = buildSceneModel(
    opened.context,
    frame.checkpoint,
    frame.records,
    frame.events,
    frame.eventRecords,
  );
  const table = renderToStaticMarkup(
    createElement(ReplayResources, { context: opened.context, checkpoint: frame.checkpoint }),
  );
  return { frame, model, table };
}

describe('#61 display records', () => {
  it('names recorded walk/run locomotion and shows stamina against its maximum', async () => {
    const run = first((c) => c.locomotion?.mode === 'run');
    const { model, table } = await view(run.step);
    const actor = model.actors.find((a) => a.id === run.change.id)!;
    expect(actor.locomotion?.mode).toBe('run');
    expect(table).toContain('走行');
    expect(table).toContain('歩行');
    const definition = opened.context.actors.find(
      (a) => a.participant.actorId === run.change.id,
    )!.character;
    expect(actor.stamina?.max).toBe(definition.stamina!.max);
    expect(table).toContain(`aria-label="${run.change.id} stamina"`);
  });
  it('labels each stage of a multi-stage technique with its declared count', async () => {
    const second = first((c) => (c.action?.stage?.contact.stageIndex ?? 0) > 0);
    const { model, table } = await view(second.step);
    const actor = model.actors.find((a) => a.id === second.change.id)!;
    expect(actor.stage).toMatchObject({
      abilityId: second.change.action!.abilityId,
      index: 1,
      count: 2,
      state: second.change.action!.stage!.state,
    });
    expect(table).toContain(`技 ${second.change.action!.abilityId} 第2段/全2段`);
  });
  it('draws recorded forced velocity and stage dash arrows in the 2D top view', async () => {
    const force = first((c) => c.force?.active === true);
    const { model, table, frame } = await view(force.step);
    const pushed = frame.checkpoint.state!.actors.find((a) => a.id === force.change.id)!;
    const arrow = model.arrows.find((a) => a.id === `${force.change.id}:force`)!;
    const applied = force.change.force!.applied;
    expect(arrow.points[0]).toEqual([pushed.position.x, pushed.position.y, pushed.position.z]);
    expect(arrow.points[1][0] - arrow.points[0][0]).toBeCloseTo(applied.x * 0.1, 9);
    expect(arrow.points[1][2] - arrow.points[0][2]).toBeCloseTo(applied.z * 0.1, 9);
    expect(table).toContain(
      `押し出し ${Math.hypot(applied.x, applied.y, applied.z).toFixed(1)} m/s`,
    );
    const dash = model.arrows.find((a) => a.kind === 'stage-motion');
    expect(dash?.id).toBe(`${force.change.force!.contributors[0]!.actorId}:stage-motion`);
    expect(table).toContain('突進');
    const hidden = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }));
    const shown = renderToStaticMarkup(
      createElement(Scene2D, { model, overlays: { ...NO_OVERLAYS, motion: true } }),
    );
    expect(hidden).not.toContain('#ff9f5a');
    expect(shown).toContain('#ff9f5a');
    expect(shown).toContain('#c9a6ff');
  });
  it('draws no force or stage arrow before one is recorded', async () => {
    const { model, table } = await view(0);
    expect(model.arrows).toEqual([]);
    expect(model.actors.every((a) => a.stage === null && a.force === null)).toBe(true);
    expect(table).toContain('停止');
  });
});
