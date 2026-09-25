import type { ActorState, MotionIntent, Gait } from '../state.ts';
import type { Journal } from './journal.ts';
import { length, sub } from '../math.ts';
import type { MovedActor } from '../world/movement.ts';
import { canMaintainFlight, flightRate, gaitProfile } from './locomotion.ts';
import { ResourceBudget, staminaExhausted } from './resources.ts';
import { postureRequiresWalk } from './posture.ts';

const unit = 1_000_000n;
const distanceUnits = (metres: number, rate: number) =>
  BigInt(Math.round(metres * 1_000_000)) * BigInt(rate);
/** Reserve the physical upper bound, then settle the collision-truncated travelled distance. */
export function reserveMotion(
  actor: ActorState,
  budget: ResourceBudget,
  step: number,
  dodge: boolean,
) {
  const character = actor.body.motion.actor.character,
    m = character.movement.locomotion;
  const displayMotion =
    !!character.stamina || !!actor.body.locomotion || actor.mind.decision.dodge !== undefined;
  const ready = !staminaExhausted(
    budget.available,
    character.stamina,
    actor.vitals.staminaClock?.exhausted,
  );
  let intent: MotionIntent = { ...actor.body.intent };
  if (intent.forced) intent = { ...intent, canMove: false, jump: false, canStep: false };
  else if (intent.authored) intent.jump = intent.authored.jump;
  if (!m && ready && !intent.flight) delete intent.speedMmPerSecond;
  const rate = intent.flight ? flightRate(actor.statuses, step) : 0;
  let flightUnits = 0n;
  if (intent.flight && rate > 0) {
    flightUnits = BigInt(rate) * 20_000n + BigInt(actor.body.motionClock?.flightRemainder ?? 0);
    if (
      !canMaintainFlight(budget.available, rate, ready) ||
      !budget.reserve('flight', [{ stamina: Number(flightUnits / unit) }]).ok
    ) {
      intent.flight = false;
      flightUnits = 0n;
    }
  }
  if (intent.flight) delete intent.speedMmPerSecond;
  let dodgePaid = false;
  if (dodge && m && ready && intent.canMove && !intent.authored && !intent.forced) {
    dodgePaid = budget.reserve('dodge', [{ stamina: m.dodgeStamina }]).ok;
    if (!dodgePaid) intent.canMove = false;
  }
  let gait: Gait = ready
    ? postureRequiresWalk(actor.body.motion)
      ? 'walk'
      : (actor.mind.decision.gait ?? 'walk')
    : 'slow';
  if (actor.body.motion.posture?.current === 'prone' || actor.body.motion.posture?.transition)
    intent.jump = false;
  let fixed = 0,
    motionUnits = 0n,
    stepRate = 0;
  let profile = gaitProfile(character, gait);
  const charged = !!m && !intent.flight && !intent.forced;
  if (character.stamina && !ready) intent.jump = false;
  if (charged) {
    const carry = BigInt(actor.body.motionClock?.remainder ?? 0);
    for (const choice of [gait, 'walk', 'slow'] as const) {
      gait = choice;
      profile = intent.authored
        ? { speedMmPerSecond: intent.authored.speedMmPerSecond, staminaPerMeter: 0 }
        : gaitProfile(character, gait);
      const jump = intent.canMove && intent.jump && actor.body.motion.grounded && ready;
      fixed = jump ? m.jumpStamina : 0;
      const canStep = intent.canMove && actor.body.motion.grounded && !jump && gait !== 'slow';
      stepRate = canStep ? m.stepStaminaPerMeter : 0;
      const maximumSpeed = Math.max(
        length({ ...actor.body.motion.velocity, y: 0 }),
        ((profile.speedMmPerSecond / 1000) * intent.speedBps) / 10000,
      );
      const maximumDistance = intent.canMove ? maximumSpeed * 0.02 + 0.000001 : 0;
      motionUnits = distanceUnits(maximumDistance, profile.staminaPerMeter) + carry;
      const maximum = motionUnits + distanceUnits(character.movement.stepHeightMm / 1000, stepRate);
      if (budget.reserve('motion', [{ stamina: Number(maximum / unit) + fixed }]).ok) {
        intent = { ...intent, speedMmPerSecond: profile.speedMmPerSecond, canStep, jump };
        break;
      }
      // An unaffordable burst is cancelled as a whole; slow locomotion remains available.
      intent.jump = false;
    }
  } else if (character.stamina && !ready) {
    intent = {
      ...intent,
      jump: false,
      canStep: false,
      ...(!intent.flight ? { speedMmPerSecond: profile.speedMmPerSecond } : {}),
    };
  }
  return {
    intent,
    settle(moved: MovedActor, journal: Journal) {
      const before = { ...actor.vitals.resources };
      let changed = false;
      if (dodgePaid) {
        budget.commit('dodge');
        changed = true;
      }
      if (flightUnits > 0n) {
        budget.commit('flight', { stamina: Number(flightUnits / unit) });
        actor.body.motionClock = {
          ...actor.body.motionClock,
          remainder: actor.body.motionClock?.remainder ?? 0,
          flightRemainder: Number(flightUnits % unit),
        };
        changed = true;
      }
      if (charged) {
        const distance = moved.trace.reduce(
          (sum, segment) => sum + length({ ...sub(segment.end, segment.start), y: 0 }),
          0,
        );
        const lift = moved.stepped
          ? moved.trace.reduce(
              (sum, segment) =>
                sum +
                (length({ ...sub(segment.end, segment.start), y: 0 }) < 1e-9
                  ? Math.max(0, segment.end.y - segment.start.y)
                  : 0),
              0,
            )
          : 0;
        const actual =
          distanceUnits(distance, profile.staminaPerMeter) +
          distanceUnits(lift, stepRate) +
          BigInt(actor.body.motionClock?.remainder ?? 0);
        const burst = moved.jumped ? m.jumpStamina : 0;
        budget.commit('motion', { stamina: Number(actual / unit) + burst });
        actor.body.motionClock = {
          ...actor.body.motionClock,
          remainder: Number(actual % unit),
          flightRemainder: actor.body.motionClock?.flightRemainder ?? 0,
        };
        changed = true;
      }
      if (
        displayMotion &&
        dodge &&
        ready &&
        intent.canMove &&
        !intent.authored &&
        !intent.forced &&
        (!m || dodgePaid)
      )
        actor.body.motionClock = {
          remainder: actor.body.motionClock?.remainder ?? 0,
          flightRemainder: actor.body.motionClock?.flightRemainder ?? 0,
          dodgeUntilStep: step + 5,
        };
      if (displayMotion)
        actor.body.locomotion = {
          mode: intent.flight
            ? 'flight'
            : length({ ...sub(moved.state.position, actor.body.motion.position), y: 0 }) > 1e-6
              ? gait
              : 'idle',
          jumping:
            !moved.state.grounded &&
            !intent.flight &&
            (moved.jumped || (actor.body.locomotion?.jumping ?? false)),
          dodging:
            ready &&
            !intent.forced &&
            !intent.authored &&
            (actor.body.motionClock?.dodgeUntilStep ?? 0) > step,
        };
      const final = budget.finish();
      actor.vitals.resources = final.resources;
      actor.actions.used = final.used;
      if (actor.vitals.staminaClock)
        actor.vitals.staminaClock.exhausted = staminaExhausted(
          actor.vitals.resources,
          character.stamina,
          actor.vitals.staminaClock.exhausted,
        );
      if (changed && before.stamina !== actor.vitals.resources.stamina)
        journal.emit({
          kind: 'cost',
          step,
          phase: 'contact',
          actorId: actor.body.motion.actor.participant.actorId,
          ruleId: 'movement.cost',
          before,
          after: { ...actor.vitals.resources },
          amount: before.stamina! - actor.vitals.resources.stamina!,
          reason: `${intent.flight ? 'flight' : gait}; jump=${moved.jumped}; step=${moved.stepped}; dodge=${dodgePaid}`,
        });
    },
  };
}
