import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { contentHash, RevisionSchema, type StreamRecord } from '@fantasy/domain/spatial';
import { sampleCatalog, catalogManifest, revisionClosure } from '@fantasy/samples';
import { prepareBattle, reference } from './prepare.ts';
import { initializePhysics } from './world/physics.ts';
import { createBattleWorld } from './world/terrain.ts';
import { Navigator } from './world/navigation.ts';
import { runBattle } from './run.ts';
beforeAll(initializePhysics);
const events = (records: StreamRecord[]) => records.flatMap((r) => ('events' in r ? r.events : []));
describe('data-composed 3D sample catalog', () => {
  it('keeps published character examples and their transitive references reproducible', async () => {
    const catalog = await sampleCatalog();
    expect(catalog.filter((r) => r.kind === 'character')).toHaveLength(22);
    expect(
      catalog.filter((r) => r.kind === 'character' && r.definition.postures).map((r) => r.id),
    ).toEqual(['posture-archer-v1', 'posture-duelist-v1']);
    for (const revision of catalog) expect(RevisionSchema.safeParse(revision).success).toBe(true);
    const saved = JSON.parse(
      readFileSync(new URL('../../../../data/spatial/catalog.json', import.meta.url), 'utf8'),
    );
    expect(await contentHash(saved)).toBe(await contentHash(catalog));
    const input = await catalogManifest('lancer', 'healer', 'flat', 400);
    const battle = await prepareBattle(input);
    expect(battle.actors[0].abilities.map((a) => a.id)).toEqual(['spear']);
    expect(battle.actors[0].equipment[0]?.attackBonus).toBe(5);
    expect(input.revisions.some((r) => r.id === 'sky-mage')).toBe(false);
    const roots = [
      ...input.participants.map((p) => ({ kind: 'character' as const, ref: p.character })),
      { kind: 'scenario' as const, ref: input.scenario },
      { kind: 'ruleset' as const, ref: input.ruleset },
    ];
    const extra = catalog.find((r) => r.kind === 'character' && r.id === 'sky-mage')!;
    expect(
      await prepareBattle({
        ...input,
        revisions: revisionClosure([...input.revisions, extra], roots),
      }),
    ).toEqual(battle);
    expect(() => revisionClosure([], [{ kind: 'character', ref: reference(extra) }])).toThrow(
      /Missing/,
    );
  });
  it.each([
    'swordsman',
    'lancer',
    'guardian',
    'archer',
    'arcane-archer',
    'fire-mage',
    'ice-mage',
    'storm-mage',
    'sky-mage',
    'healer',
    'water-observer',
    'fire-seer',
    'ember-duelist',
    'stamina-scout-v1',
    'stamina-glider-v1',
    'stage-vanguard-v1',
    'reaction-duelist-v1',
  ])('runs %s through the common rules without character-specific execution', async (id) => {
    const run = await runBattle(await catalogManifest(id, 'swordsman', 'flat', 400));
    expect(['win', 'draw']).toContain(run.result.outcome.kind);
    expect(run.result.steps).toBeLessThanOrEqual(400);
    expect(events(run.records).some((e) => e.kind === 'launch')).toBe(true);
  });
  it('routes a ground fighter around a pillar while a flying caster shoots from above, independent of enumeration', async () => {
    const input = await catalogManifest();
    const first = await runBattle(input);
    const intervals = first.records.filter((r) => r.kind === 'interval');
    const left = intervals.flatMap((r) =>
      r.paths.filter((p) => p.entityId === 'left').flatMap((p) => p.segments),
    );
    const right = intervals.flatMap((r) =>
      r.paths.filter((p) => p.entityId === 'right').flatMap((p) => p.segments),
    );
    expect(Math.max(...left.map((s) => Math.abs(s.end.z)))).toBeGreaterThan(1.3);
    expect(Math.max(...right.map((s) => s.end.y))).toBeGreaterThan(5);
    expect(
      events(first.records).some(
        (e) => e.kind === 'projectile-spawn' && e.actorId === 'right' && e.point!.y > 3,
      ),
    ).toBe(true);
    expect(['win', 'draw']).toContain(first.result.outcome.kind);
    input.participants.reverse();
    input.revisions.reverse();
    const again = await runBattle(input);
    expect(again.result.eventHash).toBe(first.result.eventHash);
    expect(again.result.trajectoryHash).toBe(first.result.trajectoryHash);
    expect(again.result.tsStateHash).toBe(first.result.tsStateHash);
    // Two complete 6000-step streams, including cognitive logs, under parallel test load.
  }, 15000);
  it('projects only policy goals onto support; explicit routes retain bridge levels and never grant flight', async () => {
    const battle = await prepareBattle(await catalogManifest('swordsman', 'swordsman', 'flat'));
    const world = createBattleWorld(battle);
    try {
      const navigator = new Navigator(world, battle.actors[0], battle.scenario, battle.rules);
      expect(navigator.groundGoal({ x: 4, y: 6, z: 0 }).y).toBeCloseTo(0.902, 6);
      expect(navigator.groundGoal({ x: 4, y: 0.902, z: 0 })).toEqual({ x: 4, y: 0.902, z: 0 });
      expect(navigator.find({ x: -4, y: 0.902, z: 0 }, { x: 4, y: 6, z: 0 }, false, 100).kind).toBe(
        'unreachable',
      );
    } finally {
      world.free();
    }
  });
});
