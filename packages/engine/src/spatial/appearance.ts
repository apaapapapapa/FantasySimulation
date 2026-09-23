import {
  LEGACY_APPEARANCE_PRIORS,
  type DeepReadonly,
  type Definition,
  type Effect,
} from '@fantasy/domain/spatial';

/** Cues are rules data, not knowledge of an opponent's definition or resistance. */
export function appearancePrior(
  appearance: DeepReadonly<Definition<'character'>['appearance']>,
  element: Extract<Effect, { kind: 'damage' }>['element'],
  priors: DeepReadonly<
    NonNullable<NonNullable<Definition<'ruleset'>['ai']>['appearancePriors']>
  > = LEGACY_APPEARANCE_PRIORS,
) {
  const cues = appearance
    ? priors.cues.filter(
        ({ match }) =>
          (!match.surface || match.surface === appearance.surface) &&
          (!match.silhouette || match.silhouette === appearance.silhouette) &&
          (!match.equipment || match.equipment.every((e) => appearance.equipment.includes(e))),
      )
    : [];
  const estimates = cues.flatMap((c) => c.efficacy.filter((e) => e.element === element));
  return {
    bps: estimates.length
      ? Math.round(estimates.reduce((sum, e) => sum + e.bps, 0) / estimates.length)
      : priors.defaultEfficacyBps,
    confidence: Math.max(0, ...cues.map((c) => c.confidenceBps)),
  };
}
