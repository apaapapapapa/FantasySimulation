import type { DecisionView, AbilityRevision } from '../state.ts';
import { type CandidateAssessment, type Cognition } from '@fantasy/domain/spatial/execution';
import { initialMovementRandom, weightedChoice, recordDecisionWeights } from './decision-random.ts';
import { payCost } from '../rules/attacks.ts';
import { canMaintainFlight, resourceReady } from '../rules/locomotion.ts';
import { dodgeOptions } from './dodge.ts';
import type { KnownClearance } from './assessment.ts';
import { postureAllows } from '../rules/posture.ts';
import { abilityPlan } from '../rules/ability-plan.ts';

export function dodgeAssessment(view: DecisionView): CandidateAssessment {
  const cost = view.self.actor.character.movement.locomotion?.dodgeStamina ?? 0;
  const costBps = Math.min(
    10000,
    Math.floor((cost * 10000) / Math.max(1, view.resources.stamina ?? 0)),
  );
  return {
    key: 'dodge',
    kind: 'dodge',
    abilityId: null,
    weight: Math.max(1, Math.floor((view.rules.dodgeWeight * 10000) / (10000 + costBps))),
    totalWeight: 1,
    successBps: 7000,
    killBps: 0,
    survivalBps: 8000,
    efficacyBps: 0,
    confidenceBps: 5000,
    durationSteps: 5,
    costBps,
    exploration: 0,
    evidence: [],
    reason: 'escape observed projectile paths; actual collision remains authoritative',
  };
}
export function passiveAssessment(moving: boolean): CandidateAssessment {
  return {
    key: moving ? 'move' : 'wait',
    kind: moving ? 'move' : 'wait',
    abilityId: null,
    weight: 1,
    totalWeight: 1,
    successBps: 10000,
    killBps: 0,
    survivalBps: 0,
    efficacyBps: 0,
    confidenceBps: 0,
    durationSteps: 5,
    costBps: 0,
    exploration: 0,
    evidence: [],
    reason: 'no executable beneficial action',
  };
}

/** The movement distribution is conditional on the selected action and the same observation. */
export function chooseMovementSlot(
  view: DecisionView,
  ability: AbilityRevision | undefined,
  flight: boolean,
  moving: boolean,
  state: number | undefined,
  clear: KnownClearance,
) {
  const excluded: string[] = [];
  const payment =
    ability &&
    payCost(ability.definition, view.resources, view.used[ability.id] ?? 0, resourceReady(view));
  const resources = payment?.ok ? payment.resources : view.resources;
  const blocks =
    view.stageOwnsMotion ||
    (!!ability &&
      ((ability.definition.castSteps === 0 && !!abilityPlan(ability).stages[0]?.selfMotion) ||
        (ability.definition.castSteps > 0 && ability.definition.movementWhileCasting === 'stop')));
  const rate = flight ? view.flightStaminaPerSecond : 0;
  const maintained = canMaintainFlight(resources, rate, resourceReady(view));
  if (blocks)
    excluded.push(
      ability?.definition.castSteps && ability.definition.movementWhileCasting === 'stop'
        ? 'selected action locks movement while casting'
        : 'own stage owns this interval movement',
    );
  if (!maintained) excluded.push('flight upkeep must remain payable');
  // Flight is protected before both slots; dodgeOptions also budgets actual travel.
  const available = {
    ...resources,
    ...(resources.stamina !== undefined
      ? { stamina: Math.max(0, resources.stamina - Math.ceil(rate * 0.02)) }
      : {}),
  };
  const directions = dodgeOptions(
    { ...view, resources: available, canMove: view.canMove !== false && !blocks && maintained },
    flight,
    clear,
  );
  const chosen = ability?.definition ?? view.activeAbility;
  if (chosen && view.self.posture)
    for (const direction of directions)
      if (
        direction.posture &&
        !postureAllows(
          { ...view.self, posture: { ...view.self.posture, current: direction.posture } },
          chosen,
        )
      ) {
        direction.weight = 0;
        direction.reason = 'selected action incompatible with this posture';
      }
  const fallback = passiveAssessment(moving);
  fallback.weight = view.rules.actionWeight;
  fallback.reason = 'retain ordinary movement and conserve evasion resources';
  const candidates = [fallback];
  if (directions.some((d) => d.weight > 0))
    candidates.push(dodgeAssessment({ ...view, resources: available }));
  else if (!excluded.length)
    excluded.push('no feasible evasion for the selected action and remaining resources');
  const before = state ?? initialMovementRandom(view.self.actor.participant.rngSeed);
  const choice = weightedChoice(
    candidates.map((c) => c.weight),
    before,
    view.rules.minimumCandidateWeightBps,
  );
  recordDecisionWeights(candidates, choice, view.rules.minimumCandidateWeightBps);
  const selected = candidates[choice.index!]!;
  for (const candidate of candidates) candidate.totalWeight = choice.total;
  const selection = selected.kind === 'dodge' ? 'dodge' : moving ? 'move' : 'wait';
  const cognition: NonNullable<Extract<Cognition, { kind: 'decision' }>['movementSlot']> = {
    selection,
    candidates,
    excluded,
    draw: { purpose: 'movement', before, after: choice.state, draws: choice.draws, selection },
  };
  return { cognition, directions, random: choice.state, dodge: selection === 'dodge' };
}
