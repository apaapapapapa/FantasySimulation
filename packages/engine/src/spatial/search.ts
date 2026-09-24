import type { DeepReadonly, Definition } from '@fantasy/domain/spatial/execution';
import type { MotionState } from './movement.ts';
import type { Observation, DecisionView } from './perception.ts';
import { add, mul, sub, length, unit, type Vec3 } from './math.ts';
import { initialSearchRandom, weightedChoice, recordDecisionWeights } from './decision-random.ts';

export type DirectionCue = {
  id: string;
  sampledAt: number;
  availableAt: number;
  origin: Vec3;
  direction: Vec3;
};
export type SearchMemory = {
  cells: { position: Vec3; confirmedAt: number | null; attemptedAt?: number }[];
  pending: { sampledAt: number; availableAt: number; cells: number[] }[];
  cues: DirectionCue[];
  lastContactAt: number;
  investigatedAt: number;
  goal?: { key: string; position: Vec3; since: number; evidenceAt: number };
};
type SearchRules = NonNullable<NonNullable<Definition<'ruleset'>['ai']>['search']>;

/** Public arena bounds define cells; only low, delayed sight measurements mark them checked. */
export function surveySearch(
  self: MotionState,
  bounds: DeepReadonly<Definition<'scenario'>['bounds']>,
  rules: DeepReadonly<SearchRules>,
  step: number,
  prior: DeepReadonly<SearchMemory> | undefined,
  observation: Observation | null,
  sees: (point: Vec3) => boolean,
): SearchMemory {
  const n = rules.cellsPerSide;
  const width = (bounds.max.x - bounds.min.x) / 1000 / n;
  const depth = (bounds.max.z - bounds.min.z) / 1000 / n;
  const state: SearchMemory = prior
    ? (structuredClone(prior) as SearchMemory)
    : {
        cells: Array.from({ length: n * n }, (_, index) => ({
          position: {
            x: bounds.min.x / 1000 + ((index % n) + 0.5) * width,
            y: bounds.min.y / 1000 + rules.lowSightMm / 1000,
            z: bounds.min.z / 1000 + (Math.floor(index / n) + 0.5) * depth,
          },
          confirmedAt: null,
        })),
        pending: [],
        cues: [],
        lastContactAt: 0,
        investigatedAt: -1,
      };
  for (const sample of state.pending.filter((s) => s.availableAt <= step))
    for (const index of sample.cells) state.cells[index]!.confirmedAt = sample.sampledAt;
  state.pending = state.pending.filter((s) => s.availableAt > step);
  const reaction = self.actor.character.perception.reactionSteps;
  if (step % reaction === 0) {
    const cells: number[] = [];
    for (const [i, cell] of state.cells.entries()) {
      // Centre plus inset corners: a high ray over a low wall cannot confirm this cell.
      const visible = [
        [0, 0],
        [-0.4, -0.4],
        [-0.4, 0.4],
        [0.4, -0.4],
        [0.4, 0.4],
      ].every(([x, z]) =>
        sees({
          ...cell.position,
          x: cell.position.x + x! * width,
          z: cell.position.z + z! * depth,
        }),
      );
      if (visible) cells.push(i);
    }
    state.pending.push({ sampledAt: step, availableAt: step + reaction, cells });
  }
  if (observation?.enemy) state.lastContactAt = observation.enemy.step;
  for (const projectile of observation?.projectiles ?? []) {
    const id = `projectile.${projectile.id}`;
    if (!length(projectile.velocity) || state.cues.some((c) => c.id === id)) continue;
    state.cues.push({
      id,
      sampledAt: observation!.sampledAt,
      availableAt: observation!.availableAt,
      origin: { ...projectile.position },
      direction: mul(unit(projectile.velocity), -1),
    });
    state.lastContactAt = Math.max(state.lastContactAt, observation!.sampledAt);
  }
  state.cues = state.cues.filter((c) => step - c.sampledAt <= rules.revisitSteps).slice(-8);
  for (const cue of state.cues)
    if (cue.availableAt <= step) state.lastContactAt = Math.max(state.lastContactAt, cue.sampledAt);
  return state;
}

export function chooseSearch(view: DecisionView, state: number | undefined) {
  const rules = view.rules?.search;
  const previous = view.memory.search;
  if (!rules || !previous || view.memory.observation?.enemy) return null;
  const memory = structuredClone(previous) as SearchMemory,
    step = view.step ?? 0;
  const lastSeen = view.memory.lastSeen;
  const cue = memory.cues
    .filter((c) => c.availableAt <= step && step - c.sampledAt <= rules.revisitSteps)
    .at(-1);
  const aggression = view.self.actor.policy.evaluation?.searchAggressionBps ?? 5000;
  const wait = Math.floor((rules.maxWaitSteps * (10000 - aggression)) / 10000);
  const forced = step - memory.lastContactAt >= rules.maxWaitSteps;
  const clueAt = Math.max(lastSeen?.step ?? -1, cue?.sampledAt ?? -1);
  if (memory.goal && clueAt > Math.max(memory.investigatedAt, memory.goal.evidenceAt))
    delete memory.goal;
  if (clueAt < 0 && step - memory.lastContactAt < wait) return null;
  const dist = (goal: Vec3) => length({ ...sub(goal, view.self.position), y: 0 });
  if (
    memory.goal &&
    (dist(memory.goal.position) < 0.6 || step - memory.goal.since >= rules.goalTimeoutSteps)
  ) {
    memory.investigatedAt = Math.max(memory.investigatedAt, memory.goal.evidenceAt);
    delete memory.goal;
  }
  let candidates: { key: string; weight: number; weightBeforeCutoff?: number }[] = [];
  let draw: { before: number; after: number; draws: number } | undefined;
  if (!memory.goal && clueAt > memory.investigatedAt) {
    const point =
      lastSeen && lastSeen.step >= (cue?.sampledAt ?? -1)
        ? lastSeen.position
        : add(cue!.origin, mul(cue!.direction, 3));
    memory.goal = {
      key: lastSeen?.step === clueAt ? 'last-seen' : 'direction-cue',
      position: { ...point, y: view.self.position.y },
      since: step,
      evidenceAt: clueAt,
    };
  }
  if (!memory.goal) {
    const weights = memory.cells.map((cell, index) => {
      const age = cell.confirmedAt === null ? rules.revisitSteps * 2 : step - cell.confirmedAt;
      const recent =
        cell.attemptedAt !== undefined && step - cell.attemptedAt < rules.goalTimeoutSteps;
      const distance = dist(cell.position);
      return {
        key: `cell.${index}`,
        weight:
          recent || distance < 0.6 || age < rules.revisitSteps
            ? 0
            : Math.max(
                1,
                Math.min(1_000_000, Math.floor((Math.min(age, 8000) * 100) / (1 + distance))),
              ),
      };
    });
    // If every cell is fresh, rotate toward the least recently checked area, still bounded.
    if (!weights.some((c) => c.weight))
      for (const [i, c] of weights.entries())
        c.weight =
          dist(memory.cells[i]!.position) < 0.6
            ? 0
            : Math.max(1, step - (memory.cells[i]!.confirmedAt ?? 0) + 1);
    const before = state ?? initialSearchRandom(view.self.actor.participant.rngSeed);
    const choice = weightedChoice(
      weights.map((c) => c.weight),
      before,
      view.rules?.minimumCandidateWeightBps,
    );
    recordDecisionWeights(weights, choice, view.rules?.minimumCandidateWeightBps);
    candidates = weights;
    draw = { before, after: choice.state, draws: choice.draws };
    if (choice.index !== null) {
      const cell = memory.cells[choice.index]!;
      cell.attemptedAt = step;
      memory.goal = {
        key: weights[choice.index]!.key,
        position: { ...cell.position, y: view.self.position.y },
        since: step,
        evidenceAt: -1,
      };
    }
  }
  return { memory, goal: memory.goal?.position ?? null, forced, waitSteps: wait, candidates, draw };
}
