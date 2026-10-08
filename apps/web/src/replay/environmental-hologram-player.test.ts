import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import {
  canonicalJson,
  replayChunkRecords,
  replayContext,
  seekReplayState,
} from '@fantasy/domain/spatial';
import { ManifestBuilder, prepareBattle, runPreparedBattle } from '@fantasy/engine/spatial';
import { sampleCatalog } from '@fantasy/samples';
import { ReplayWriter } from '../../../api/src/replay/replay-writer.ts';
import { environmentalHologramManifest } from '../../../../packages/engine/test-support/environmental-holograms.ts';
import type { OpenedReplay } from './open-replay.ts';
import { expandArtifact } from './artifacts.ts';
import { EnvironmentalHolograms3D } from './SceneEffects.tsx';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';

type SavedProjection = {
  id: string;
  creatorId: string;
  observerId: string;
  sourcePosition: { x: number; y: number; z: number };
  perceivedPosition: { x: number; y: number; z: number };
  state: 'active-unobserved' | 'observed' | 'invalidated';
  activatedAt: number;
  observedAt: number;
  invalidatedAt: number;
  expiresAt: number;
};
type SavedCheckpoint = {
  state?: {
    actors: { sensorView?: { environmentalHolograms: SavedProjection[] } }[];
  };
};

it('restores an actual multi-chunk hologram recording forward, reverse and across a loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hologram-replay-'));
  try {
    const fixture = await environmentalHologramManifest(350, 300),
      fixtureAbility = fixture.revisions.find(
        (revision) => revision.kind === 'ability' && revision.id === 'sk07-hologram',
      ),
      productionAbility = (await sampleCatalog()).find(
        (revision) => revision.kind === 'ability' && revision.id === 'side-step-image-v1',
      );
    if (fixtureAbility?.kind !== 'ability' || productionAbility?.kind !== 'ability')
      throw new Error('Missing hologram abilities');
    const input = await ManifestBuilder.relink(fixture, [
      { from: fixtureAbility, to: productionAbility },
    ]);
    expect(input.participants[0]!.character).not.toEqual(fixture.participants[0]!.character);
    expect(input.revisions).toContainEqual(
      expect.objectContaining({
        kind: 'ability',
        id: 'side-step-image-v1',
        revision: 1,
        contentHash: 'sha256:96e42f32200a1d27beffa1a185a79206b847ce2a1ff162b680150bab6a0aa1fa',
      }),
    );
    const battle = await prepareBattle(input);
    const output = await runPreparedBattle(battle);
    const writer = await ReplayWriter.create(root, {
      id: 'hologram-player',
      attemptId: 'attempt-1',
      simulationHash: output.result.simulationHash,
      input: battle.manifest,
    });
    for (const record of output.records) await writer.append(record);
    const manifest = await writer.finish({ kind: 'result', result: output.result }, 'result-1');
    expect(manifest.chunks.length).toBeGreaterThan(1);
    const directory = join(root, 'hologram-player');
    const context = await replayContext(battle.manifest, manifest.simulationHash);
    const loads: string[] = [];
    const checkpoints = async (index: number) => {
      const ref = manifest.checkpoints[index]!;
      loads.push(ref.file);
      const bytes = new Uint8Array(await readFile(join(directory, ref.file)));
      return JSON.parse(await expandArtifact(bytes, ref));
    };
    const records = async (index: number) => {
      const ref = manifest.chunks[index]!;
      loads.push(ref.file);
      const bytes = new Uint8Array(await readFile(join(directory, ref.file)));
      return replayChunkRecords(await expandArtifact(bytes, ref), ref);
    };
    const opened: OpenedReplay = {
      manifest,
      context,
      records,
      seek: (nextRecord) =>
        seekReplayState(context, manifest, nextRecord, { checkpoint: checkpoints, records }),
    };
    const last = manifest.chunks.length - 1;
    loads.length = 0;
    await opened.seek(manifest.chunks[last]!.firstRecord);
    expect(loads).toEqual([manifest.checkpoints[last]!.file]);
    loads.length = 0;
    await opened.seek(manifest.chunks[last]!.firstRecord + 1);
    expect(loads).toEqual([manifest.checkpoints[last]!.file, manifest.chunks[last]!.file]);

    const activeIndex = (
      await Promise.all(
        manifest.checkpoints.map(async (ref, index) => ({
          index,
          value: JSON.parse(
            await expandArtifact(new Uint8Array(await readFile(join(directory, ref.file))), ref),
          ) as SavedCheckpoint,
        })),
      )
    ).find(({ value }) =>
      value.state?.actors.some(
        (actor) => (actor.sensorView?.environmentalHolograms.length ?? 0) > 0,
      ),
    )?.index;
    if (activeIndex === undefined) throw new Error('Missing active saved checkpoint');
    const activeRef = manifest.checkpoints[activeIndex]!;
    const activeBytes = new Uint8Array(await readFile(join(directory, activeRef.file)));
    const activeRaw = await expandArtifact(activeBytes, activeRef);
    const variants: ((checkpoint: SavedCheckpoint) => void)[] = [
      (checkpoint) => {
        const projection = checkpoint.state!.actors.flatMap(
          (actor) => actor.sensorView?.environmentalHolograms ?? [],
        )[0]!;
        projection.id += '.tampered';
      },
      (checkpoint) => {
        const projection = checkpoint.state!.actors.flatMap(
          (actor) => actor.sensorView?.environmentalHolograms ?? [],
        )[0]!;
        projection.sourcePosition.x++;
        projection.perceivedPosition.x++;
      },
      (checkpoint) => {
        for (const actor of checkpoint.state!.actors)
          if (actor.sensorView) actor.sensorView.environmentalHolograms = [];
      },
      (checkpoint) => {
        const projection = checkpoint.state!.actors.flatMap(
          (actor) => actor.sensorView?.environmentalHolograms ?? [],
        )[0]!;
        projection.activatedAt++;
        projection.observedAt++;
        projection.invalidatedAt++;
        projection.expiresAt++;
      },
    ];
    for (const mutate of variants) {
      const checkpoint = JSON.parse(activeRaw) as SavedCheckpoint;
      mutate(checkpoint);
      const tampered = new Uint8Array(gzipSync(JSON.stringify(checkpoint)));
      await expect(expandArtifact(tampered, activeRef)).rejects.toThrow(/size and checksum/);
    }

    const player = new ReplayPlayer(opened);
    const expected = new Map<number, string>();
    for (const step of [0, 100, 275])
      expected.set(step, canonicalJson((await player.frame(step)).checkpoint));
    const sequence = [0, 100, 275, 0, 275, 100];
    const actual = [];
    for (const step of sequence) actual.push(canonicalJson((await player.frame(step)).checkpoint));
    expect(actual).toEqual(sequence.map((step) => expected.get(step)));

    const lifecycle = output.records
      .flatMap((record) => ('events' in record ? record.events : []))
      .flatMap((event) => (event.environmentalHologram ? [event.environmentalHologram] : []));
    const firstId = lifecycle[0]?.id;
    const transitions = lifecycle.filter((hologram) => hologram.id === firstId);
    const activeStep = transitions.find(
      (hologram) => hologram.transition === 'activated',
    )?.activatedAt;
    const invalidatedStep = transitions.find(
      (hologram) => hologram.transition === 'invalidated',
    )?.invalidatedAt;
    const absentStep = transitions.find((hologram) => hologram.transition === 'expired')?.expiresAt;
    if (
      firstId === undefined ||
      activeStep === undefined ||
      invalidatedStep === undefined ||
      absentStep === undefined
    )
      throw new Error('Missing complete hologram lifecycle');
    const activeProjection = transitions[0]!;
    const displaySequence = [activeStep, invalidatedStep, absentStep, activeStep, absentStep];
    for (const step of displaySequence) {
      const frame = await player.frame(step);
      const truth = buildSceneModel(
        opened.context,
        frame.checkpoint,
        frame.records,
        frame.events,
        frame.eventRecords,
      );
      const observer = buildSceneModel(
        opened.context,
        frame.checkpoint,
        frame.records,
        frame.events,
        frame.eventRecords,
        { actorId: activeProjection.observerId },
      );
      const creator = buildSceneModel(
        opened.context,
        frame.checkpoint,
        frame.records,
        frame.events,
        frame.eventRecords,
        { actorId: activeProjection.creatorId },
      );
      const expectedState =
        step === activeStep ? 'active-unobserved' : step === invalidatedStep ? 'invalidated' : null;
      const truthProjection = truth.environmentalHolograms.find(
        (hologram) => hologram.id === firstId,
      );
      const observerProjection = observer.environmentalHolograms.find(
        (hologram) => hologram.id === firstId,
      );
      const creatorProjection = creator.environmentalHolograms.find(
        (hologram) => hologram.id === firstId,
      );
      expect(truthProjection).toEqual(
        expectedState === null
          ? undefined
          : {
              id: firstId,
              creatorId: activeProjection.creatorId,
              observerId: activeProjection.observerId,
              position: [
                activeProjection.perceivedPosition.x,
                activeProjection.perceivedPosition.y,
                activeProjection.perceivedPosition.z,
              ],
              state: expectedState,
            },
      );
      expect(observerProjection).toEqual(truthProjection);
      expect(creatorProjection).toBeUndefined();
      expect(truth.environmentalHolograms).toHaveLength(
        frame.checkpoint.state!.actors.flatMap(
          (actor) => actor.sensorView?.environmentalHolograms ?? [],
        ).length,
      );
      expect(observer.environmentalHolograms).toHaveLength(
        frame.checkpoint.state!.actors.find((actor) => actor.id === activeProjection.observerId)!
          .sensorView!.environmentalHolograms.length,
      );
      expect(creator.environmentalHolograms).toHaveLength(
        frame.checkpoint.state!.actors.find((actor) => actor.id === activeProjection.creatorId)!
          .sensorView!.environmentalHolograms.length,
      );
      expect(truthProjection).not.toEqual(
        expect.objectContaining({
          position: [
            activeProjection.sourcePosition.x,
            activeProjection.sourcePosition.y,
            activeProjection.sourcePosition.z,
          ],
        }),
      );
      const two = renderToStaticMarkup(
        createElement(Scene2D, { model: truth, overlays: NO_OVERLAYS }),
      );
      const three = renderToStaticMarkup(createElement(EnvironmentalHolograms3D, { model: truth }));
      const expectedCount = truth.environmentalHolograms.length;
      expect((two.match(/data-environmental-hologram=/g) ?? []).length).toBe(expectedCount);
      expect((three.match(/data-environmental-hologram=/g) ?? []).length).toBe(expectedCount);
      expect((two.match(/data-hologram-state="invalidated"/g) ?? []).length).toBe(
        truth.environmentalHolograms.filter((hologram) => hologram.state === 'invalidated').length,
      );
      expect((three.match(/data-hologram-state="invalidated"/g) ?? []).length).toBe(
        truth.environmentalHolograms.filter((hologram) => hologram.state === 'invalidated').length,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
