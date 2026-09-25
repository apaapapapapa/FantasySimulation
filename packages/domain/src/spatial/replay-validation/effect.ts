import { matchEffect, type EffectHandlers, type EffectVariant } from '../variants.ts';
import type { ForceContribution } from '../records.ts';

// Saved v1 records only have a definition-bound per-effect payload for force.
// Other effects retain the existing event/resource checks; adding validation here
// would reject previously accepted saved bytes.
const noForceDisplay = () => false;
const forceDisplay: EffectHandlers<ForceContribution, boolean> = {
  damage: noForceDisplay,
  heal: noForceDisplay,
  shield: noForceDisplay,
  water: noForceDisplay,
  reveal: noForceDisplay,
  dispel: noForceDisplay,
  'apply-status': noForceDisplay,
  force: (effect, display) => effect.durationSteps === display.endAt - display.startAt,
};
export function matchesForceDisplay(effect: EffectVariant, display: ForceContribution) {
  return matchEffect(effect, forceDisplay, display);
}
