import { beforeAll, expect, it } from 'vite-plus/test';
import { aiFixture, incomingArrow } from '../../test-support/ai.ts';
import { initializePhysics, SpatialWorld } from './physics.ts';
import { advancePosture, postureAllows, postureSpeed } from './posture.ts';
import { TACTICAL_AI, tacticalPostures } from '@fantasy/samples';
import { STANDARD_BODY } from '@fantasy/samples';
import { hitscan } from './attacks.ts';
import { perceive, emptyMemory } from './perception.ts';
import { dodgeOptions } from './dodge.ts';
import { coverOptions } from './cover.ts';
import { Navigator } from './navigation.ts';
import { advanceLocomotion, locomotionFixture, locomotion } from '../../test-support/locomotion.ts';
import { runBattle } from './run.ts';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { battleEvents, combatManifest } from '../../test-support/fixtures.ts';
import { withTacticalRules } from '../../test-support/tactics.ts';
import { chooseGait } from './locomotion.ts';
import { selfView } from './self-view.ts';

beforeAll(initializePhysics);
it('performs a seeded ground jump against a real projectile without granting flight', async () => {
  const arrow = (await sampleCatalog()).find((r) => r.kind === 'ability' && r.id === 'arrow')!;
  if (arrow.kind !== 'ability' || arrow.definition.attack.kind !== 'projectile')
    throw Error('Missing arrow');
  const input = await withTacticalRules(
    await combatManifest(80, {
      ability: {
        ...arrow.definition,
        castSteps: 0,
        recoverySteps: 70,
        attack: { ...arrow.definition.attack, speedMmPerSecond: 10000 },
      },
      character: { postures: tacticalPostures(STANDARD_BODY) },
      policy: { movement: 'hold', jumpWhenBlocked: false },
    }),
  );
  const run = await runBattle(input);
  const decisions = battleEvents(run.records).flatMap((e) =>
    e.cognition?.kind === 'decision' ? [e.cognition] : [],
  );
  expect(
    decisions.some((c) => c.draws.some((d) => d.purpose === 'dodge' && d.selection === 'up')),
  ).toBe(true);
  const heights = run.records.flatMap((r) =>
    r.kind === 'interval'
      ? r.paths.filter((p) => p.entityId === 'left').flatMap((p) => p.segments.map((s) => s.end.y))
      : [],
  );
  expect(Math.max(...heights)).toBeGreaterThan(2);
  expect(heights.at(-1)).toBeLessThan(0.903);
  expect((await runBattle(input)).result).toEqual(run.result);
});
it('never turns an arena floor into cover beyond the public bounds', async () => {
  const run = await runBattle(
    await catalogManifest(
      'posture-archer-v1',
      'posture-duelist-v1',
      'flat-surveyed-v1',
      200,
      42,
      'standard-tactics-v1',
    ),
  );
  expect(
    battleEvents(run.records).some((e) => e.cognition?.kind === 'decision' && e.cognition.cover),
  ).toBe(false);
});
it.each(['crouching', 'prone'] as const)(
  'enforces %s speed and jump restrictions at the motion boundary',
  async (stance) => {
    const f = await locomotionFixture();
    try {
      const actor = f.actor.motion.actor;
      f.actor.motion = {
        ...f.actor.motion,
        posture: { current: 'standing', standingBody: actor.character.body },
        actor: {
          ...actor,
          character: { ...actor.character, postures: tacticalPostures(actor.character.body) },
        },
      };
      f.actor.motion = advancePosture(f.actor.motion, stance, 0, f.world, []);
      f.actor.decision.gait = 'run';
      f.actor.intent.speedBps = postureSpeed(f.actor.motion);
      f.actor.intent.jump = true;
      const startX = f.actor.motion.position.x;
      for (let step = 0; step < (stance === 'prone' ? 20 : 10); step++) {
        const { moved } = advanceLocomotion(f, step);
        expect(moved.jumped).toBe(false);
      }
      expect(f.actor.motion.posture?.current).toBe('standing');
      expect(f.actor.motion.position.x - startX).toBeCloseTo(stance === 'prone' ? 0.16 : 0.2, 4);
      expect(f.actor.resources.stamina).toBe(100);
      expect(f.actor.motionClock?.remainder).toBe(stance === 'prone' ? 320000 : 400000);
      expect(chooseGait(selfView(f.actor, 9, TACTICAL_AI, f.battle.statuses), 0, true)?.gait).toBe(
        'walk',
      );
      f.actor.motion = advancePosture(f.actor.motion, undefined, 20, f.world, []);
      const { plan, moved } = advanceLocomotion(f, 21);
      expect(plan.intent.speedMmPerSecond).toBe(2000);
      expect(plan.intent.speedBps).toBe(stance === 'prone' ? 2000 : 5000);
      expect(moved.jumped).toBe(stance === 'crouching');
      expect(f.actor.resources.stamina).toBe(stance === 'prone' ? 100 : 92);
    } finally {
      f.world.free();
    }
  },
);
async function fixture() {
  const f = await aiFixture({ character: { postures: tacticalPostures(STANDARD_BODY) } });
  return { ...f, self: { ...f.self, grounded: true }, enemy: { ...f.enemy, grounded: true } };
}
it('changes the physical capsule after the authored delay, preserves feet and delays posture observation', async () => {
  const f = await fixture();
  try {
    let enemy = advancePosture(f.enemy, 'prone', 0, f.world, []);
    expect(enemy.actor.character.body.heightMm).toBe(1800);
    enemy = advancePosture(enemy, undefined, 19, f.world, []);
    expect(enemy.posture?.current).toBe('standing');
    const standingHit = hitscan(f.world, f.self, enemy, { x: 1, y: 0, z: 0 }, 20000, 0);
    expect(standingHit?.kind).toBe('body');
    enemy = advancePosture(enemy, undefined, 20, f.world, []);
    expect(enemy.posture?.current).toBe('prone');
    expect(enemy.position.y).toBeCloseTo(f.enemy.position.y - 0.6);
    expect(enemy.actor.character.body.heightMm).toBe(600);
    expect(hitscan(f.world, f.self, enemy, { x: 1, y: 0, z: 0 }, 20000, 0)).toBeNull();
    expect(postureSpeed(enemy)).toBe(2000);
    let memory = perceive(f.world, f.self, enemy, [], 20, emptyMemory());
    expect(memory.observation).toBeNull();
    memory = perceive(f.world, f.self, enemy, [], 25, memory);
    expect(memory.observation?.enemy).toMatchObject({ posture: 'prone', size: { heightMm: 600 } });
    const melee = {
      ...f.abilities[0]!.definition,
      attack: {
        kind: 'melee' as const,
        reachMm: 1000,
        radiusMm: 100,
        activeSteps: 1,
        maxHitsPerTarget: 1,
      },
    };
    expect(postureAllows(enemy, melee)).toBe(false);
    expect(postureAllows(enemy, f.abilities[0]!.definition)).toBe(true);
  } finally {
    f.world.free();
  }
});
it('refuses to stand into a ceiling and does not shrink when the transition is incomplete', async () => {
  const f = await fixture();
  const world = new SpatialWorld([
    {
      id: 'ceiling',
      position: { ...f.self.position, y: 1.5 },
      halfExtents: { x: 2, y: 0.3, z: 2 },
      blocks: { movement: true, vision: true, attack: true },
    },
  ]);
  try {
    let self = advancePosture(f.self, 'prone', 0, f.world, []);
    self = advancePosture(self, undefined, 20, f.world, []);
    self = advancePosture(self, 'standing', 21, world, []);
    self = advancePosture(self, undefined, 41, world, []);
    expect(self.posture?.current).toBe('prone');
    expect(self.actor.character.body.heightMm).toBe(600);
  } finally {
    f.world.free();
    world.free();
  }
});
it('offers ground jump and lowering only when reaction time, resources and ceiling allow', async () => {
  const f = await fixture();
  try {
    const view = {
      ...f.view,
      self: f.self,
      rules: TACTICAL_AI,
      memory: {
        ...f.view.memory,
        observation: {
          ...f.view.memory.observation!,
          projectiles: [incomingArrow(f.self.position)],
        },
      },
    };
    const available = dodgeOptions(view, false, () => true);
    expect(available.find((d) => d.key === 'up')).toMatchObject({ jump: true });
    expect(available.find((d) => d.key === 'up')!.weight).toBeGreaterThan(0);
    expect(available.find((d) => d.key === 'down')).toMatchObject({ posture: 'prone' });
    expect(dodgeOptions(view, false, () => false).every((d) => d.weight === 0)).toBe(true);
    const late = { ...view, step: 37 };
    expect(dodgeOptions(late, false, () => true).find((d) => d.key === 'up')!.weight).toBe(0);
    const constrained = {
      ...view,
      resources: { ...view.resources, stamina: 5 },
      self: {
        ...f.self,
        actor: {
          ...f.self.actor,
          character: {
            ...f.self.actor.character,
            stamina: { max: 100, recoveryPerSecond: 0 },
            movement: { ...f.self.actor.character.movement, locomotion: locomotion() },
          },
        },
      },
    };
    const low = dodgeOptions(constrained, false, () => true);
    expect(low.find((d) => d.key === 'down')!.weight).toBeGreaterThan(0);
    expect(low.filter((d) => d.key !== 'down').every((d) => d.weight === 0)).toBe(true);
    let prone = advancePosture(constrained.self, 'prone', 0, f.world, []);
    prone = advancePosture(prone, undefined, 20, f.world, []);
    const slow = {
      ...constrained,
      self: prone,
      speedBps: 2000,
      resources: { ...constrained.resources, stamina: 100 },
      memory: {
        ...view.memory,
        observation: { ...view.memory.observation!, projectiles: [incomingArrow(prone.position)] },
      },
    };
    expect(dodgeOptions(slow, false, () => true).every((d) => d.weight === 0)).toBe(true);
  } finally {
    f.world.free();
  }
});
it('selects low or high cover using only the provided terrain and estimated enemy', async () => {
  const f = await fixture();
  try {
    for (const height of [0.7, 3]) {
      const wall = {
        id: 'cover',
        position: { x: -2, y: height / 2, z: 0 },
        halfExtents: { x: 0.15, y: height / 2, z: 0.5 },
        blocks: { movement: true, vision: true, attack: true },
      };
      const world = new SpatialWorld([wall]);
      try {
        const navigator = new Navigator(world, f.self.actor, f.battle.scenario, f.battle.rules);
        const options = coverOptions(
          { ...f.view, self: f.self, rules: TACTICAL_AI },
          {
            bounds: f.battle.scenario.bounds,
            obstacles: [wall],
            blocked: (a, b, layer) => world.occluded(a, b, layer),
          },
          (a, b, body) => navigator.knownClearance(a, b, body),
        );
        expect(options.length).toBeGreaterThan(0);
        expect(options[0]!.posture).toBe(height === 3 ? 'standing' : 'prone');
        expect(
          coverOptions(
            { ...f.view, self: { ...f.self, grounded: false }, rules: TACTICAL_AI },
            {
              bounds: f.battle.scenario.bounds,
              obstacles: [wall],
              blocked: (a, b, layer) => world.occluded(a, b, layer),
            },
            (a, b, body) => navigator.knownClearance(a, b, body),
          ).map((o) => o.posture),
        ).toEqual(height === 3 ? ['standing'] : []);
      } finally {
        world.free();
      }
    }
  } finally {
    f.world.free();
  }
});
