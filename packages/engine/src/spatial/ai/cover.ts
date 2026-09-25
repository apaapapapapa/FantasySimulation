import type { Obstacle } from '../geometry-types.ts';
import type { DecisionView } from '../state.ts';
import type { Definition, DeepReadonly, Posture } from '@fantasy/domain/spatial/execution';
import type { KnownClearance } from './assessment.ts';
import { add, sub, mul, length, unit, type Vec3 } from '../math.ts';
import { postureBody, postureAllows } from '../rules/posture.ts';
import { initialCoverRandom, weightedChoice, recordDecisionWeights } from './decision-random.ts';

/** Supplied only by surveyed terrain or delayed measured patches; never the live enemy. */
export type TacticalTerrain = {
  bounds: DeepReadonly<Definition<'scenario'>['bounds']>;
  obstacles: readonly Obstacle[];
  blocked(from: Vec3, to: Vec3, layer: 'vision' | 'attack'): boolean;
};
export function coverOptions(
  view: DecisionView,
  terrain: TacticalTerrain,
  clear: KnownClearance,
  selected?: DeepReadonly<Definition<'ability'>>,
) {
  if (!view.rules.search || !view.canMove || view.stageOwnsMotion) return [];
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
  const cue = view.memory.search?.cues.filter((c) => c.availableAt <= view.step).at(-1);
  const estimate = target?.position ?? (cue ? add(cue.origin, mul(cue.direction, 3)) : null);
  if (!estimate) return [];
  if (
    !view.memory.observation?.enemy &&
    view.step - (view.memory.search?.lastContactAt ?? 0) >= view.rules.search.maxWaitSteps
  )
    return [];
  const aversion = 20000 - (view.self.actor.policy.evaluation?.riskToleranceBps ?? 10000);
  const survival = view.self.actor.policy.evaluation?.survivalBps ?? 10000;
  const pressure =
    1 + (view.memory.observation?.projectiles.length ?? 0) + (target?.action === 'cast' ? 1 : 0);
  // Without an observed shot or cast, hiding only delays engagement (two melee actors can
  // otherwise shelter behind the same pillar until time runs out).
  if (view.rules.cover === 'observed-threat-v1' && pressure === 1) return [];
  const candidates = [];
  const obstacles = terrain.obstacles
    .filter((o) => !o.id.startsWith('boundary.'))
    .sort(
      (a, b) =>
        length(sub(a.position, view.self.position)) - length(sub(b.position, view.self.position)) ||
        a.position.x - b.position.x ||
        a.position.z - b.position.z,
    )
    .slice(0, 8);
  for (const [index, obstacle] of obstacles.entries()) {
    const away = unit({ ...sub(obstacle.position, estimate), y: 0 });
    if (!length(away)) continue;
    const extent = Math.sqrt(obstacle.halfExtents.x ** 2 + obstacle.halfExtents.z ** 2);
    const offset = extent + view.self.actor.character.body.radiusMm / 1000 + 0.12;
    const point = add(obstacle.position, mul(away, offset));
    for (const posture of ['standing', 'crouching', 'prone'] as const) {
      if (!view.self.grounded && posture !== (view.self.posture?.current ?? 'standing')) continue;
      const body = postureBody(view.self, posture);
      if (!body) continue;
      const own = view.self.posture
        ? { ...view.self, posture: { ...view.self.posture, current: posture } }
        : view.self;
      if (selected && !postureAllows(own, selected)) continue;
      const feet = view.self.position.y - view.self.actor.character.body.heightMm / 2000;
      const goal = { ...point, y: feet + body.heightMm / 2000 };
      if (
        ['x', 'z'].some((axis) => {
          const key = axis as 'x' | 'z';
          const radius = body.radiusMm / 1000;
          return (
            goal[key] - radius < terrain.bounds.min[key] / 1000 ||
            goal[key] + radius > terrain.bounds.max[key] / 1000
          );
        })
      )
        continue;
      const top = { ...goal, y: goal.y + body.heightMm / 2000 - 0.05 };
      // Use only estimated opponent height; cut both sight and shot to the entire capsule top.
      const source = { ...estimate, y: estimate.y + 0.6 };
      if (
        !clear(goal, goal, body) ||
        !terrain.blocked(source, top, 'vision') ||
        !terrain.blocked(source, top, 'attack')
      )
        continue;
      const distance = length(sub(goal, view.self.position));
      candidates.push({
        key: `cover.${index}.${posture}`,
        goal,
        posture: posture as Posture,
        weight: Math.min(
          1_000_000,
          Math.max(1, Math.floor((pressure * aversion * survival) / 10000 / (10 + distance * 10))),
        ),
        reason: 'known terrain cuts estimated sight and shot',
      });
      break; // Prefer the highest usable stance; equivalent cover need not add redundant weight.
    }
  }
  return candidates;
}
export function chooseCover(
  view: DecisionView,
  terrain: TacticalTerrain | undefined,
  clear: KnownClearance,
  state: number | undefined,
  selected?: DeepReadonly<Definition<'ability'>>,
) {
  if (!terrain) return null;
  const covers = coverOptions(view, terrain, clear, selected);
  if (!covers.length) return null;
  const ordinary = { key: 'ordinary', weight: view.rules.actionWeight };
  const candidates = [ordinary, ...covers.map(({ key, weight }) => ({ key, weight }))];
  const before = state ?? initialCoverRandom(view.self.actor.participant.rngSeed);
  const choice = weightedChoice(
    candidates.map((c) => c.weight),
    before,
    view.rules.minimumCandidateWeightBps,
  );
  recordDecisionWeights(candidates, choice, view.rules.minimumCandidateWeightBps);
  return {
    selected: choice.index ? covers[choice.index - 1]! : null,
    candidates,
    draw: {
      purpose: 'cover' as const,
      before,
      after: choice.state,
      draws: choice.draws,
      selection: candidates[choice.index!]!.key,
    },
  };
}
