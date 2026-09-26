import { DEFAULT_BUDGET, type Budget, type Definition } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';
import { prepareBattle } from '../src/spatial/prepare.ts';
import { initialActor } from '../src/spatial/sim/combat-state.ts';
import { StepTransaction, type SimulationState } from '../src/spatial/sim/step-transaction.ts';
import { WorkMeter } from '../src/spatial/sim/work-meter.ts';
import { createBattleWorld } from '../src/spatial/world/terrain.ts';
import { HitLedger } from '../src/spatial/rules/hit-ledger.ts';

export async function relocationManifest(edit: Partial<Definition<'ability'>> = {}, steps = 5) {
  const input = await combatManifest(steps, {
    ids: {
      ability: 'spatial-teleport-test',
      character: 'spatial-traveller-test',
      policy: 'spatial-placement-test',
    },
    ability: {
      target: 'self',
      attack: { kind: 'direct' },
      effects: [],
      castSteps: 0,
      recoverySteps: 3,
      cooldownSteps: 30,
      costs: { hp: 0, mp: 3, uses: 1 },
      relocation: { anchor: 'self', direction: 'back', distanceMm: 2000, maxDistanceMm: 2000 },
      ...edit,
    },
    policy: { movement: 'hold', preferredDistanceMm: 9000, jumpWhenBlocked: false },
  });
  input.participants[0].position.x = -2000;
  input.participants[1].position.x = 2000;
  return input;
}

/** A paid/released state for independently authored boundary proposals; no expected values. */
export async function spatialTransaction(
  options: { budget?: Partial<Budget>; ability?: Partial<Definition<'ability'>> } = {},
) {
  const battle = await prepareBattle(await relocationManifest(options.ability));
  const world = createBattleWorld(battle),
    budget = { ...DEFAULT_BUDGET, ...options.budget };
  const actors = battle.actors.map((resolved, index) => {
    const actor = initialActor(world, resolved),
      ability = resolved.abilities[0]!;
    actor.vitals.resources.mp -= 3;
    actor.actions.used[ability.id] = 1;
    actor.actions.action = {
      id: `fixture.${index}`,
      ability,
      cause: 'e.0',
      startedAt: 0,
      launchAt: 0,
      recoveryUntil: 3,
      released: true,
    };
    return actor;
  });
  const previous: SimulationState = {
    actors,
    melees: [],
    projectiles: [],
    ledger: new HitLedger(),
    serial: 2,
  };
  const context = { battle, world, budget, navigators: new Map(), work: new WorkMeter(budget) };
  return {
    battle,
    world,
    previous,
    context,
    tx: new StepTransaction(context, previous, 1, 10, 0, 'boundary'),
  };
}
