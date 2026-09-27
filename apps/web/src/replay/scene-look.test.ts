import { describe, expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReplayContext } from '@fantasy/domain/spatial';
import { savedReplay } from '../../test-support/saved-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { mapWindow, Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';

async function* frames(name: string, steps: Iterable<number>) {
  const opened = await savedReplay(name),
    player = new ReplayPlayer(opened);
  for (const step of steps) {
    const frame = await player.frame(step);
    yield {
      context: opened.context,
      frame,
      model: buildSceneModel(
        opened.context,
        frame.checkpoint,
        frame.records,
        frame.events,
        frame.eventRecords,
      ),
    };
  }
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** Expected colour family read straight from the saved ability revision. */
function savedTint(context: ReplayContext, abilityId: string | null) {
  const revision = context.manifest.revisions.find(
    (r) => r.kind === 'ability' && r.id === abilityId,
  );
  if (revision?.kind !== 'ability') return null;
  return revision.definition.effects.find((e) => e.kind === 'damage')?.element ?? null;
}

describe('display fields for the pixel-art replay', () => {
  it('derives tints, HP, strikes and pose inputs from recorded state and saved definitions', async () => {
    const seen = { cast: 0, projectile: 0, hit: 0, struck: 0 };
    for await (const { context, frame, model } of frames('swordsman-sky-mage-240', range(0, 240))) {
      const state = frame.checkpoint.state!;
      expect(model.step).toBe(frame.checkpoint.step);
      expect(model.milliseconds).toBe(frame.checkpoint.step * 20);
      state.actors.forEach((raw, i) => {
        const actor = model.actors[i]!;
        const character = context.actors.find((a) => a.participant.actorId === raw.id)!.character;
        expect(actor.hp).toEqual({ value: raw.resources.hp, max: character.stats.hp });
        expect(actor.pose).toEqual({
          defeated: raw.resources.hp <= 0,
          posture: raw.posture?.current ?? 'standing',
          grounded: raw.grounded,
          locomotion: raw.locomotion ?? null,
          phase: raw.action?.phase ?? null,
        });
        expect(actor.feet).toBeCloseTo(raw.position.y - character.body.heightMm / 2000, 9);
        expect(actor.look).toEqual({ silhouette: 'humanoid', equipment: [] });
        expect(actor.tint).toBe(raw.action ? savedTint(context, raw.action.abilityId) : null);
        if (raw.action?.phase === 'cast' && actor.tint) seen.cast++;
        const struck = frame.events.some(
          (e) => (e.kind === 'hit' || e.kind === 'damage') && e.targetId === raw.id,
        );
        expect(actor.struck).toBe(struck);
        if (struck) seen.struck++;
      });
      state.projectiles.forEach((raw, i) => {
        expect(model.projectiles[i]!.tint).toBe(savedTint(context, raw.abilityId));
        seen.projectile++;
      });
      for (const effect of model.effects) {
        const event = frame.events.find((e) => e.id === effect.id)!;
        expect(effect.tint).toBe(savedTint(context, event.abilityId));
        if (effect.kind === 'hit') seen.hit++;
      }
    }
    // The fixture casts the arcane seeker, flies it and lands one hit.
    expect(seen.cast).toBeGreaterThan(0);
    expect(seen.projectile).toBeGreaterThan(0);
    expect(seen.hit).toBe(1);
    expect(seen.struck).toBeGreaterThan(0);
  });
  it('keeps recorded terrain materials and movement blocking for textures', async () => {
    for await (const { context, model } of frames('swordsman-sky-mage-240', [0])) {
      const scenario = context.manifest.revisions.find((r) => r.kind === 'scenario')!;
      if (scenario.kind !== 'scenario') throw new Error('scenario');
      expect(model.obstacles.map((o) => [o.id, o.material, o.solid])).toEqual(
        scenario.definition.obstacles.map((o) => [
          o.id,
          o.material ?? 'generic',
          o.blocks.movement,
        ]),
      );
    }
  });
  it('groups the recorded blade poses of one stage into one tinted sweep', async () => {
    let checked = 0;
    for await (const { context, frame, model } of frames(
      'stage-vanguard-staged-duelist-300',
      range(80, 100),
    ))
      for (const raw of frame.checkpoint.state!.actors) {
        const geometry = raw.action?.stage?.geometry;
        if (geometry?.kind !== 'blade') continue;
        const blades = model.shapes.filter((s) => s.group === `${raw.id}:stage`);
        expect(blades).toHaveLength(geometry.poses.length);
        expect(blades.every((s) => s.kind === 'blade' && s.actorId === raw.id)).toBe(true);
        expect(blades.map((s) => s.points[1])).toEqual(
          geometry.poses.map((p) => [p.tip.x, p.tip.y, p.tip.z]),
        );
        const stageEffects = context.manifest.revisions.find(
          (r) => r.kind === 'ability' && r.id === raw.action!.abilityId,
        );
        if (stageEffects?.kind !== 'ability') throw new Error('ability');
        const element = [
          ...stageEffects.definition.effects,
          ...(stageEffects.definition.stages ?? []).flatMap((s) => s.effects),
        ].find((e) => e.kind === 'damage');
        expect(
          blades.every((s) => s.tint === (element?.kind === 'damage' ? element.element : null)),
        ).toBe(true);
        checked++;
      }
    expect(checked).toBeGreaterThan(0);
  });
  it('marks projectiles turned back by a recorded deflection', async () => {
    for await (const { frame, model } of frames('p6-deflection-160', [10, 11]))
      frame.checkpoint.state!.projectiles.forEach((raw, i) =>
        expect(model.projectiles[i]!.deflected).toBe(!!raw.deflection),
      );
    for await (const { model } of frames('p6-deflection-160', [11]))
      expect(model.projectiles.some((p) => p.deflected)).toBe(true);
  });
});

describe('2D top view', () => {
  it('frames the fighters at zoom 1, zooms out to the arena and follows a focus', async () => {
    for await (const { model } of frames('swordsman-sky-mage-240', [0, 120])) {
      const window = mapWindow(model, 1);
      for (const a of model.actors) {
        expect(a.position[0]).toBeGreaterThan(window.x + 4);
        expect(a.position[0]).toBeLessThan(window.x + window.width - 4);
        expect(a.position[2]).toBeGreaterThan(window.z + 4);
        expect(a.position[2]).toBeLessThan(window.z + window.depth - 4);
      }
      expect(window.width).toBeLessThan(model.max[0] - model.min[0]);
      const arena = mapWindow(model, 1 / 8);
      expect(arena).toEqual({
        x: model.min[0],
        z: model.min[2],
        width: model.max[0] - model.min[0],
        depth: model.max[2] - model.min[2],
      });
      const followed = mapWindow(model, 2, model.follow);
      expect(followed.x + followed.width / 2).toBeCloseTo(model.follow[0], 9);
      expect(followed.z + followed.depth / 2).toBeCloseTo(model.follow[2], 9);
    }
  });
  it('labels each fighter with its saved name and recorded HP', async () => {
    for await (const { model } of frames('swordsman-sky-mage-240', [240])) {
      const markup = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }));
      expect(markup).toContain('保存ログの2D表示');
      for (const a of model.actors) expect(markup).toContain(`>${a.name}</text>`);
      expect(markup.match(/class="map-plate"/g)).toHaveLength(model.actors.length);
    }
  });
});
