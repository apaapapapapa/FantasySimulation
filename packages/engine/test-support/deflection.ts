import type { Definition } from '@fantasy/domain/spatial';
import { reactionManifest } from './reactions.ts';

export const deflectionShape: Extract<Definition<'ability'>['attack'], { kind: 'projectile' }> = {
  kind: 'projectile',
  speedMmPerSecond: 100000,
  radiusMm: 20,
  lifetimeSteps: 30,
  gravityScaleBps: 0,
  homingTurnMilliDegreesPerSecond: 0,
  observation: 'owner-visible',
  explosionRadiusMm: 0,
  maxHitsPerTarget: 1,
};
export const deflectionResponse: Partial<Definition<'ability'>> = {
  reaction: { response: { kind: 'deflect' } },
};
export function deflectionManifest(options: Partial<Parameters<typeof reactionManifest>[0]> = {}) {
  return reactionManifest({
    reactions: [deflectionResponse],
    leftReactions: false,
    rightAttack: false,
    ...options,
    attack: { attack: deflectionShape, ...options.attack },
  });
}
