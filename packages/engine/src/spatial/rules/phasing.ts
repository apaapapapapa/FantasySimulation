import type { PhaseContribution } from '@fantasy/domain/spatial/execution';
import type { ActorState } from '../state.ts';
export { combinedPhase, bodyWorld, attackWorld } from '../world/phasing.ts';
export function activePhaseContributions(
  actor: ActorState,
  step: number,
  sealed: boolean,
): PhaseContribution[] {
  if (sealed) return [];
  return actor.statuses.flatMap((status) => {
    const spec = status.revision.definition.phasing;
    if (!spec || status.startStep > step || step >= status.endStep) return [];
    return [
      {
        materials: [...spec.materials],
        floor: spec.floor,
        revision: {
          id: status.revision.id,
          revision: status.revision.revision,
          contentHash: status.revision.contentHash,
        },
        causes: [...status.causes],
      },
    ];
  });
}
