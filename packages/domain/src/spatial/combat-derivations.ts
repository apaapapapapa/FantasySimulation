import { matchAttack, type AttackHandlers } from './variants.ts';
import type { DeepReadonly } from './canonical.ts';
import type { Definition, Stage } from './contracts.ts';
import type { ForceContribution } from './records.ts';

export const DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND = 100_000;

type Ability = DeepReadonly<Definition<'ability'>>;
const activeSteps: AttackHandlers<undefined, number> = {
  area: () => 1,
  beam: () => 1,
  direct: () => 1,
  arc: () => 1,
  radial: () => 1,
  hitscan: () => 1,
  projectile: () => 1,
  melee: (shape) => shape.activeSteps,
};
export const attackActiveSteps = (attack: Ability['attack']) =>
  matchAttack(attack, activeSteps, undefined);
export function stageWindow(launchAt: number, stage: Pick<Stage, 'offsetSteps' | 'durationSteps'>) {
  const startAt = launchAt + stage.offsetSteps;
  return { startAt, endAt: startAt + stage.durationSteps };
}
export function actionActiveUntil(launchAt: number, ability: Ability) {
  const last = ability.stages?.at(-1);
  return last ? stageWindow(launchAt, last).endAt : launchAt + attackActiveSteps(ability.attack);
}
/** Action speed scales preparation/recovery/cooldown, never active durations. */
export function actionClock(ability: Ability, speedBps: number, step: number) {
  if (speedBps === 0) return null;
  const delay = (value: number) => Math.ceil((value * 10000) / speedBps);
  const launchAt = step + delay(ability.castSteps);
  return {
    launchAt,
    recoveryUntil: actionActiveUntil(launchAt, ability) + Math.max(1, delay(ability.recoverySteps)),
    cooldownUntil: launchAt + delay(ability.cooldownSteps),
  };
}
export type ActionClock = NonNullable<ReturnType<typeof actionClock>>;

/** Integer contributions are summed before a single cap, preserving cancellation. */
export function composeForce(
  contributors: readonly Pick<ForceContribution, 'velocityMmPerSecond'>[],
  capMmPerSecond: number,
) {
  const axes = ['x', 'y', 'z'] as const;
  const totals = { x: 0n, y: 0n, z: 0n };
  for (const force of contributors)
    for (const axis of axes) totals[axis] += BigInt(force.velocityMmPerSecond[axis]);
  const square = axes.reduce((n, axis) => n + totals[axis] ** 2n, 0n);
  const capped = square > BigInt(capMmPerSecond) ** 2n;
  const scale = capped ? capMmPerSecond / Math.sqrt(Number(square)) / 1000 : 0.001;
  return {
    active: square > 0n,
    capped,
    force: {
      x: Number(totals.x) * scale,
      y: Number(totals.y) * scale,
      z: Number(totals.z) * scale,
    },
  };
}
