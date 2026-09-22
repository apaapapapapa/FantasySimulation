import { expect, it } from 'vite-plus/test';
import type { Definition } from '@fantasy/domain/spatial';
import {
  battleEvents,
  boxObstacle,
  combatManifest,
  editScenario,
} from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';

const attacks: { attack: Definition<'ability'>['attack']; rule: string }[] = [
  {
    attack: { kind: 'melee', reachMm: 1800, radiusMm: 200, activeSteps: 2, maxHitsPerTarget: 1 },
    rule: 'melee.muzzle-blocked',
  },
  {
    attack: {
      kind: 'projectile',
      speedMmPerSecond: 50000,
      radiusMm: 50,
      lifetimeSteps: 10,
      gravityScaleBps: 0,
      homingTurnMilliDegreesPerSecond: 0,
      observation: 'launch-only',
      explosionRadiusMm: 0,
      maxHitsPerTarget: 1,
    },
    rule: 'projectile.muzzle-blocked',
  },
];
it.each(attacks)(
  'preserves the $rule event without launching or damaging',
  async ({ attack, rule }) => {
    const manifest = await combatManifest(20, {
      ability: {
        attack,
        rangeMm: 20000,
        castSteps: 0,
        recoverySteps: 1,
        costs: { hp: 0, mp: 0, uses: 1 },
      },
      policy: { movement: 'hold' },
    });
    await editScenario(manifest, (scenario) => {
      // Opposite facings put the lateral muzzle offsets on opposite sides.
      for (const z of [-150, 150])
        scenario.obstacles.push({
          ...boxObstacle(`muzzle-screen-${z}`, { x: 0, y: 1000, z }, { x: 10000, y: 1000, z: 5 }),
          blocks: { movement: false, vision: false, attack: true },
        });
    });
    const run = await runBattle(manifest);
    const events = battleEvents(run.records);
    const blocked = events.filter((event) => event.ruleId === rule);
    expect(blocked).toHaveLength(2);
    expect(new Set(blocked.map((event) => event.actorId))).toEqual(new Set(['left', 'right']));
    expect(blocked.every((event) => event.kind === 'fizzle' && event.parentEventId !== null)).toBe(
      true,
    );
    expect(
      events.some((event) => event.kind === 'projectile-spawn' || event.kind === 'damage'),
    ).toBe(false);
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
  },
);
