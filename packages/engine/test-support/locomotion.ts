import { DEFAULT_BUDGET, type Definition } from '@fantasy/domain/spatial';
import { sampleManifest } from '@fantasy/samples';
import { combatManifest, editScenario, type BoxObstacle } from './fixtures.ts';
import { prepareBattle } from '../src/spatial/prepare.ts';
import { createBattleWorld } from '../src/spatial/terrain.ts';
import { initialActor } from '../src/spatial/combat-state.ts';
import { reserveMotion } from '../src/spatial/motion-resources.ts';
import { ResourceBudget } from '../src/spatial/resources.ts';
import { moveActors } from '../src/spatial/movement.ts';
import { Journal } from '../src/spatial/journal.ts';

export const locomotion = (): NonNullable<Definition<'character'>['movement']['locomotion']> => ({
  walk: { speedMmPerSecond: 2000, staminaPerMeter: 2 },
  run: { speedMmPerSecond: 6000, staminaPerMeter: 6 },
  exhaustedSpeedMmPerSecond: 500,
  jumpStamina: 8,
  dodgeStamina: 5,
  stepStaminaPerMeter: 10,
});
export async function locomotionFixture(obstacles: BoxObstacle[] = []) {
  const base = (await sampleManifest()).revisions.find((r) => r.kind === 'character')!;
  const manifest = await combatManifest(100, {
    character: {
      stamina: { max: 100, recoveryPerSecond: 10, resumeAt: 10 },
      movement: {
        ...base.definition.movement,
        accelerationMmPerSecond2: 100000,
        locomotion: locomotion(),
      },
    },
    policy: { movement: 'approach', preferredDistanceMm: 1000, priorities: [] },
  });
  await editScenario(manifest, (scenario) => {
    scenario.obstacles.push(...obstacles);
    scenario.terrainKnowledge = 'surveyed';
  });
  const battle = await prepareBattle(manifest),
    world = createBattleWorld(battle);
  const actor = initialActor(world, battle.actors[0]);
  actor.intent.direction = { x: 1, y: 0, z: 0 };
  return { manifest, battle, world, actor };
}
export function advanceLocomotion(
  f: Awaited<ReturnType<typeof locomotionFixture>>,
  step: number,
  options: { budget?: ResourceBudget; journal?: Journal; dodge?: boolean } = {},
) {
  const plan = reserveMotion(
    f.actor,
    options.budget ?? new ResourceBudget(f.actor.resources),
    step,
    options.dodge ?? false,
  );
  const moved = moveActors(
    f.world,
    [f.actor.motion],
    new Map([['left', plan.intent]]),
    f.battle.rules,
  )[0]!;
  plan.settle(moved, options.journal ?? new Journal(0, 0, DEFAULT_BUDGET));
  f.actor.motion = moved.state;
  return { plan, moved };
}
